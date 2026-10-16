// The shape of a ruleset: its blocks, match paths, wildcards and functions.
//
// Read from the tokens of ./scan in one pass, with no grammar beyond
// brackets and the headers that open them, so that it answers for text that
// does not parse yet — which is all text while it is being typed. An
// unclosed block runs to the end of the document; a stray closer closes
// nothing.

import type { Text } from '@codemirror/state'
import { type ScanState, type Token, initialState, lex } from './scan'

export type BracketKind =
  | 'service'
  | 'match'
  | 'function'
  | 'block'
  | 'map'
  | 'paren'
  | 'square'
  | 'interpolation'

export interface Wildcard {
  name: string
  /** `{name=**}`, which binds the rest of the path rather than one segment. */
  recursive: boolean
}

export interface Bracket {
  kind: BracketKind
  /** Where the opening token starts. */
  open: number
  /** The first position inside: just after the opening token. */
  start: number
  /** Where the closing token starts, or null while it is unclosed. */
  end: number | null
  parent: Bracket | null
  /** For a match: its header's path as written, such as `/users/{uid}`. */
  path: string
  /** For a match: the wildcards its header binds, in order. */
  wildcards: Wildcard[]
}

export interface FunctionInfo {
  name: string
  params: string[]
  /** Where its name is. */
  at: number
  /** The block it is declared in, which is where it can be called; null at the top. */
  scope: Bracket | null
  body: Bracket | null
}

export interface Binding {
  name: string
  at: number
  /** The block it is declared in. */
  scope: Bracket | null
  /** Where its statement's `;` is, or null while it has none. */
  end: number | null
}

export interface Outline {
  /** Every token, comments included. */
  tokens: Token[]
  /** The tokens without comments, which is what structure is read from. */
  code: Token[]
  /** Every bracket, in the order they open. */
  brackets: Bracket[]
  functions: FunctionInfo[]
  bindings: Binding[]
}

const BRACE_KINDS: ReadonlySet<BracketKind> = new Set([
  'service',
  'match',
  'function',
  'block',
  'map',
])
const BLOCK_KINDS: ReadonlySet<BracketKind> = new Set(['service', 'match', 'function', 'block'])
const PAREN_KINDS: ReadonlySet<BracketKind> = new Set(['paren', 'interpolation'])
const SQUARE_KINDS: ReadonlySet<BracketKind> = new Set(['square'])

export function isBlock(bracket: Bracket | null): boolean {
  return bracket !== null && BLOCK_KINDS.has(bracket.kind)
}

export function isBrace(bracket: Bracket): boolean {
  return BRACE_KINDS.has(bracket.kind)
}

function parseWildcard(text: string): Wildcard {
  const inner = text.replace(/^\{/, '').replace(/\}$/, '')
  const recursive = inner.endsWith('=**')
  return { name: recursive ? inner.slice(0, -3) : inner, recursive }
}

type Pending =
  | { kind: 'service' }
  | { kind: 'match'; path: string; wildcards: Wildcard[] }
  | { kind: 'function'; name: string; at: number; params: string[] }

function build(text: string): Outline {
  const tokens = lex(text)
  const code = tokens.filter((t) => t.style !== 'lineComment' && t.style !== 'blockComment')
  const brackets: Bracket[] = []
  const functions: FunctionInfo[] = []
  const bindings: Binding[] = []
  const stack: Bracket[] = []
  let pending: Pending | null = null
  let binding: Binding | null = null

  const open = (kind: BracketKind, t: Token): Bracket => {
    const bracket: Bracket = {
      kind,
      open: t.from,
      start: t.to,
      end: null,
      parent: stack.at(-1) ?? null,
      path: '',
      wildcards: [],
    }
    brackets.push(bracket)
    stack.push(bracket)
    return bracket
  }
  // The scanner closes the innermost bracket of a matching kind and
  // whatever was left open inside it; this keeps the same books.
  const close = (kinds: ReadonlySet<BracketKind>, t: Token) => {
    let i = stack.length - 1
    while (i >= 0 && !kinds.has(stack[i]!.kind)) i--
    if (i < 0) return
    while (stack.length > i) stack.pop()!.end = t.from
  }

  for (const t of code) {
    switch (t.style) {
      case 'keyword':
      case 'definitionKeyword':
        if (t.text === 'service') pending = { kind: 'service' }
        else if (t.text === 'match') pending = { kind: 'match', path: '', wildcards: [] }
        else if (t.text === 'function')
          pending = { kind: 'function', name: '', at: t.from, params: [] }
        break
      case 'path':
        if (pending?.kind === 'match') pending.path += t.text
        break
      case 'wildcard':
        if (pending?.kind === 'match') {
          pending.path += t.text
          pending.wildcards.push(parseWildcard(t.text))
        }
        break
      case 'functionDef':
        if (pending?.kind === 'function') {
          pending.name = t.text
          pending.at = t.from
        }
        break
      case 'definition':
        if (t.after.params) {
          if (pending?.kind === 'function') pending.params.push(t.text)
        } else {
          binding = { name: t.text, at: t.from, scope: stack.at(-1) ?? null, end: null }
          bindings.push(binding)
        }
        break
      case 'brace':
        if (t.text === '{') {
          const block = t.after.stack.endsWith('{')
          const bracket = open(block ? (pending?.kind ?? 'block') : 'map', t)
          if (block && pending?.kind === 'match') {
            bracket.path = pending.path
            bracket.wildcards = pending.wildcards
          }
          if (block && pending?.kind === 'function')
            functions.push({
              name: pending.name,
              params: pending.params,
              at: pending.at,
              scope: bracket.parent,
              body: bracket,
            })
          if (block) pending = null
        } else {
          close(BRACE_KINDS, t)
        }
        break
      case 'paren':
        if (t.text === '(') open('paren', t)
        else close(PAREN_KINDS, t)
        break
      case 'interpolation':
        if (t.text === '$(') open('interpolation', t)
        else close(PAREN_KINDS, t)
        break
      case 'squareBracket':
        if (t.text === '[') open('square', t)
        else close(SQUARE_KINDS, t)
        break
      case 'separator':
        if (t.text === ';') {
          pending = null
          if (binding && binding.end === null) binding.end = t.from
          binding = null
        }
        break
    }
  }
  return { tokens, code, brackets, functions, bindings }
}

let lastText: string | null = null
let lastOutline: Outline | null = null

/** The outline of `text`, remembered for the last text asked about. */
export function outline(text: string): Outline {
  if (lastText !== text || !lastOutline) {
    lastOutline = build(text)
    lastText = text
  }
  return lastOutline
}

/** Whether `pos` is inside the bracket: after its opener, up to its closer. */
export function contains(bracket: Bracket, pos: number): boolean {
  return pos >= bracket.start && (bracket.end === null || pos <= bracket.end)
}

/** The innermost bracket around `pos`, or null at the top level. */
export function innermostAt(o: Outline, pos: number): Bracket | null {
  let best: Bracket | null = null
  for (const bracket of o.brackets) {
    if (bracket.start > pos) break
    if (contains(bracket, pos)) best = bracket
  }
  return best
}

/** The brackets around `pos`, outermost first. */
export function chainAt(o: Outline, pos: number): Bracket[] {
  const chain: Bracket[] = []
  for (let b = innermostAt(o, pos); b; b = b.parent) chain.unshift(b)
  return chain
}

/** The match blocks around `pos`, outermost first. */
export function matchesAt(o: Outline, pos: number): Bracket[] {
  return chainAt(o, pos).filter((b) => b.kind === 'match')
}

function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '')
}

/**
 * The match path around `pos` below the documents root, as
 * `/users/{uid}/orders/{orderId}`, from the headers of every enclosing
 * match joined together.
 */
export function matchPathIn(o: Outline, pos: number): string | null {
  const all = matchesAt(o, pos).flatMap((b) => segments(b.path))
  if (all.length < 3 || all[0] !== 'databases' || all[2] !== 'documents') return null
  const rest = all.slice(3)
  return rest.length ? `/${rest.join('/')}` : null
}

/** The wildcards bound around `pos`, outermost first. */
export function wildcardInfoAt(o: Outline, pos: number): Wildcard[] {
  return matchesAt(o, pos).flatMap((b) => b.wildcards)
}

/**
 * The match path enclosing `pos`, relative to
 * `/databases/{database}/documents`, e.g. "/users/{uid}/orders/{orderId}";
 * null outside any match below the documents root.
 */
export function enclosingMatchPath(text: string, pos: number): string | null {
  return matchPathIn(outline(text), pos)
}

const RECURSIVE = /^\{\w*=\*\*\}$/

// "/users/{uid}/orders/{orderId}" → "users/*/orders": the collection
// whose documents the path matches, wildcards as `*`. Null for a path with
// a recursive wildcard, or one that ends on a collection rather than a
// document. (A line comment, because that pattern would close a block one.)
export function documentPattern(matchPath: string): string | null {
  const parts = segments(matchPath)
  if (parts.length === 0 || parts.length % 2 !== 0) return null
  if (parts.some((part) => RECURSIVE.test(part))) return null
  return parts
    .slice(0, -1)
    .map((part) => (part.startsWith('{') ? '*' : part))
    .join('/')
}

/** Wildcard variables bound by the matches enclosing `pos`, innermost last. */
export function wildcardsAt(text: string, pos: number): string[] {
  return wildcardInfoAt(outline(text), pos).map((w) => w.name)
}

/** The scanner's state before the code token at `index`. */
export function stateBefore(o: Outline, index: number): ScanState {
  return index > 0 ? o.code[index - 1]!.after : initialState()
}

const outlines = new WeakMap<Text, Outline>()

/**
 * The outline of an editor document. A `Text` never changes, so this is
 * read once per version of the document however often the fold gutter
 * and completion ask.
 */
export function outlineOf(doc: Text): Outline {
  let found = outlines.get(doc)
  if (!found) {
    found = outline(doc.toString())
    outlines.set(doc, found)
  }
  return found
}
