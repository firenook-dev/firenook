// Completion for security rules, by where the cursor stands.
//
// The scanner's state after the token before the cursor says what may come
// next — a member after a dot, an operation after `allow`, a statement
// after a block's `{` or a `;`, an expression after an operator — and the
// outline says what is in scope there: the wildcards of the enclosing
// matches, the functions declared around them, a function's parameters
// and lets. After a dot, the receiver is followed back to a type as far as
// that can be done from the text alone: `request.auth.token` is the token
// map, `.diff(…)` gives a MapDiff, `resource.data` is the document's map,
// whose fields come from the data the console has seen.
//
// Storage's rules are the same language with other names in scope: the
// dialect (the page's, or the text's own `service firebase.storage`) picks
// `match /b/{bucket}/o`, a request with no query, `resource` as the file
// (`size`, `contentType`, `metadata`, …), its custom metadata keys sampled
// from the bucket, and `firestore.get()` / `firestore.exists()` in place of
// Firestore's own `get()` and `exists()`.

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  insertCompletionText,
  pickedCompletion,
  snippet,
  snippetCompletion,
} from '@codemirror/autocomplete'
import type { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  DOCUMENT_FUNCTIONS,
  type Entry,
  FIRESTORE_NAMESPACE,
  GENERIC_METHODS,
  type GenericMethod,
  GLOBAL_FUNCTION_ENTRIES,
  GLOBAL_VARIABLES,
  KEYWORD_INFO,
  type Kind,
  LITERALS,
  MAP_LIKE,
  METHODS,
  NAMESPACE_ENTRIES,
  NAMESPACE_FUNCTIONS,
  OPERATION_ENTRIES,
  PROPERTIES,
  type RulesDialect,
  STORAGE_KEYWORD_INFO,
  STORAGE_OBJECT,
  STORAGE_OPERATION_ENTRIES,
  STORAGE_REQUEST,
  STORAGE_VARIABLES,
  TYPE_NAMES,
  showKind,
  signature,
} from './catalog'
import type { RulesLanguageOptions } from './options'
import {
  type Bracket,
  type FunctionInfo,
  type Outline,
  chainAt,
  contains,
  documentPattern,
  innermostAt,
  isBlock,
  matchPathIn,
  matchesAt,
  outlineOf,
  stateBefore,
} from './outline'
import { NAMESPACES, type Style, type Token, initialState } from './scan'

type Result = CompletionResult | null
type Answer = Result | Promise<Result>

/** What a completion is resolved against. */
interface Scope {
  o: Outline
  /** Where the word being completed starts. */
  at: number
  doc: Text
  options: RulesLanguageOptions
  dialect: RulesDialect
}

/** A type, with what is known of the document it describes. */
interface Ty {
  kind: Kind
  /** For a resource or its data: the collection pattern of the document. */
  pattern: string | null
  /** For data: the map keys already walked, as `address.`. */
  prefix: string
}

function ty(kind: Kind, pattern: string | null = null, prefix = ''): Ty {
  return { kind, pattern, prefix }
}

const VALID_FOR = /^\w*$/
const IDENTIFIER = /^[A-Za-z_]\w*$/
const RESERVED: ReadonlySet<string> = new Set([
  'allow',
  'false',
  'function',
  'if',
  'in',
  'is',
  'let',
  'match',
  'null',
  'return',
  'service',
  'true',
])

// Ranks, high to low. CodeMirror orders by how well the typed text
// matches, then by these.
const RANK = {
  field: 20,
  own: 10,
  local: 5,
  wildcard: 4,
  userFunction: 3,
  variable: 2,
  globalFunction: 1,
  namespace: 0,
  methods: 0,
  literal: -1,
  other: -10,
} as const

/** The completion source for a ruleset, registered as the language's `autocomplete` data. */
export function rulesCompletionSource(options: RulesLanguageOptions = {}): CompletionSource {
  return (context) => complete(context, options)
}

function complete(context: CompletionContext, options: RulesLanguageOptions): Answer {
  const { state, pos } = context
  const o = outlineOf(state.doc)
  const around = tokenAround(o.tokens, pos)
  if (around && opaque(around, pos)) return null

  const word = context.matchBefore(/\w*/) ?? { from: pos, to: pos, text: '' }
  const index = lastCodeBefore(o.code, word.from)
  const prev = index >= 0 ? o.code[index]! : null
  const st = prev ? prev.after : initialState()
  const dialect = options.dialect ?? dialectOf(o)
  const scope: Scope = { o, at: word.from, doc: state.doc, options, dialect }
  const from = word.from

  // `service cloud.firestore` or `service firebase.storage`: the one product
  // name each kind of ruleset has.
  if (st.header === 'service') {
    if (prev?.text === 'service')
      return result(from, [dialect === 'storage' ? STORAGE_SERVICE_NAME : SERVICE_NAME])
    if (prev?.text === '.' && o.code[index - 1]?.text === 'cloud')
      return result(from, [{ label: 'firestore', type: 'namespace', info: 'Cloud Firestore.' }])
    if (prev?.text === '.' && o.code[index - 1]?.text === 'firebase')
      return result(from, [
        { label: 'storage', type: 'namespace', info: 'Cloud Storage for Firebase.' },
      ])
    return null
  }
  if (st.prev === 'dot') return members(scope, index)
  if (!word.text && !context.explicit) return null
  // Naming something: a function, a parameter, a let.
  if (st.params || st.binding || st.prev === 'function') return null
  if (st.header === 'match') {
    const block = innermostAt(o, from)
    return prev?.text === 'match' && block?.kind === 'service'
      ? result(from, [dialect === 'storage' ? BUCKETS_PATH : DATABASES_PATH])
      : null
  }
  if (st.allow) {
    if (prev?.text !== 'allow' && prev?.text !== ',') return null
    return result(from, operations(o, index, dialect))
  }
  if (prev?.text === ':' && prev.style === 'punctuation' && stateBefore(o, index).allow)
    return result(from, [keyword('if', dialect)])
  if (st.prev === 'is') return result(from, TYPE_NAMES.map(typeCompletion))
  if (st.prev === 'start') {
    const block = innermostAt(o, from)
    if (block === null || isBlock(block)) return result(from, statements(block, scope))
  }
  if (st.prev === 'operand') return result(from, [keyword('in', dialect), keyword('is', dialect)])
  return result(from, expressions(scope))
}

/**
 * The dialect a text declares in its `service` header: `firebase.storage`
 * is Storage's; anything else, or no header yet, is Firestore's.
 */
export function dialectOf(o: Outline): RulesDialect {
  const at = o.code.findIndex((t) => t.text === 'service' && t.style === 'keyword')
  if (at < 0) return 'firestore'
  let name = ''
  for (let i = at + 1; i < o.code.length && o.code[i]!.text !== '{'; i++) name += o.code[i]!.text
  return name === 'firebase.storage' ? 'storage' : 'firestore'
}

function result(from: number, options: Completion[]): CompletionResult {
  return { from, options, validFor: VALID_FOR }
}

/** The token that `pos` is inside or at the end of. */
function tokenAround(tokens: readonly Token[], pos: number): Token | null {
  let lo = 0
  let hi = tokens.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tokens[mid]!.from < pos) lo = mid + 1
    else hi = mid
  }
  const token = tokens[lo - 1]
  return token && token.to >= pos ? token : null
}

/**
 * Whether `pos` is somewhere completion has nothing to say: in a comment,
 * a string, a number or a path. The end of a closed string or comment is
 * outside it.
 */
function opaque(token: Token, pos: number): boolean {
  switch (token.style) {
    case 'lineComment':
    case 'path':
    case 'escape':
    case 'number':
      return true
    case 'blockComment':
      return !(pos === token.to && !token.after.comment)
    case 'string':
      return !(pos === token.to && token.after.quote === '')
    case 'wildcard':
      return !(pos === token.to && token.text.endsWith('}'))
    default:
      return false
  }
}

/** The index of the last code token ending at or before `pos`, or -1. */
function lastCodeBefore(code: readonly Token[], pos: number): number {
  let lo = 0
  let hi = code.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (code[mid]!.to <= pos) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

function lineOf(scope: Scope, at: number): number {
  return scope.doc.lineAt(Math.min(at, scope.doc.length)).number
}

// --- Statements --------------------------------------------------------

const SERVICE_NAME: Completion = {
  label: 'cloud.firestore',
  type: 'namespace',
  info: 'Cloud Firestore: the rules in this block secure its documents.',
}

const DATABASES_PATH: Completion = {
  label: '/databases/{database}/documents',
  type: 'text',
  detail: 'documents root',
  info: "The root of every database's documents. Matches inside it are relative to it.",
}

const STORAGE_SERVICE_NAME: Completion = {
  label: 'firebase.storage',
  type: 'namespace',
  info: 'Cloud Storage for Firebase: the rules in this block secure its files.',
}

const BUCKETS_PATH: Completion = {
  label: '/b/{bucket}/o',
  type: 'text',
  detail: 'objects root',
  info: "The root of every bucket's files. Matches inside it are relative to it.",
}

/** What a keyword means, in the dialect's words. */
function keywordInfo(name: string, dialect: RulesDialect): string | undefined {
  return (dialect === 'storage' ? STORAGE_KEYWORD_INFO[name] : undefined) ?? KEYWORD_INFO[name]
}

function keyword(name: string, dialect: RulesDialect, boost = 0): Completion {
  const info = keywordInfo(name, dialect)
  return { label: name, type: 'keyword', boost, ...(info ? { info } : {}) }
}

function snip(template: string, label: string, detail: string, dialect: RulesDialect): Completion {
  const info = keywordInfo(label, dialect)
  return snippetCompletion(template, {
    label,
    type: 'keyword',
    detail,
    boost: 1,
    ...(info ? { info } : {}),
  })
}

function statements(block: Bracket | null, scope: Scope): Completion[] {
  const { dialect } = scope
  if (!block)
    return [
      keyword('rules_version', dialect),
      snip("rules_version = '2';", 'rules_version', "= '2';", dialect),
      keyword('service', dialect),
      dialect === 'storage'
        ? snip(
            'service firebase.storage {\n\tmatch /b/{bucket}/o {\n\t\t${}\n\t}\n}',
            'service',
            'firebase.storage { … }',
            dialect,
          )
        : snip(
            'service cloud.firestore {\n\tmatch /databases/{database}/documents {\n\t\t${}\n\t}\n}',
            'service',
            'cloud.firestore { … }',
            dialect,
          ),
    ]
  if (block.kind === 'function')
    return [
      keyword('let', dialect),
      snip('let ${name} = ${value};', 'let', '… = …;', dialect),
      keyword('return', dialect),
      snip('return ${expression};', 'return', '…;', dialect),
    ]
  const inService = block.kind === 'service' && matchesAt(scope.o, scope.at).length === 0
  const options = [
    keyword('match', dialect),
    inService
      ? dialect === 'storage'
        ? snip('match /b/{bucket}/o {\n\t${}\n}', 'match', '/b/{bucket}/o { … }', dialect)
        : snip(
            'match /databases/{database}/documents {\n\t${}\n}',
            'match',
            '/databases/{database}/documents { … }',
            dialect,
          )
      : dialect === 'storage'
        ? snip('match /${folder}/{${file}} {\n\t${}\n}', 'match', '/…/{…} { … }', dialect)
        : snip('match /${collection}/{${document}} {\n\t${}\n}', 'match', '/…/{…} { … }', dialect),
    keyword('function', dialect),
    snip(
      'function ${name}(${}) {\n\treturn ${expression};\n}',
      'function',
      '…() { return …; }',
      dialect,
    ),
  ]
  if (!inService)
    options.push(
      keyword('allow', dialect),
      snip('allow ${read}: if ${condition};', 'allow', '…: if …;', dialect),
    )
  return options
}

/** The operations for an `allow`, less those it already lists. */
function operations(o: Outline, index: number, dialect: RulesDialect): Completion[] {
  const listed = new Set<string>()
  for (let i = index; i >= 0; i--) {
    const t = o.code[i]!
    if (t.style === 'operation') listed.add(t.text)
    else if (t.style !== 'separator' || t.text !== ',') break
  }
  const entries = dialect === 'storage' ? STORAGE_OPERATION_ENTRIES : OPERATION_ENTRIES
  return entries
    .filter((op) => !listed.has(op.name))
    .map((op, i, all) => ({
      label: op.name,
      type: 'keyword',
      detail: op.detail,
      info: op.info,
      boost: all.length - i,
    }))
}

function typeCompletion(entry: Entry): Completion {
  return { label: entry.name, type: 'type', info: entry.info }
}

// --- Expressions -------------------------------------------------------

function enclosingFunction(scope: Scope): FunctionInfo | null {
  const chain = chainAt(scope.o, scope.at)
  for (let i = chain.length - 1; i >= 0; i--) {
    const bracket = chain[i]!
    if (bracket.kind === 'function')
      return scope.o.functions.find((f) => f.body === bracket) ?? null
  }
  return null
}

/** The name the documents root binds the database to, for writing a document path. */
function databaseName(scope: Scope): string | null {
  for (const match of matchesAt(scope.o, scope.at)) {
    const parts = match.path.split('/').filter(Boolean)
    if (parts[0] === 'databases') return /^\{(\w+)\}$/.exec(parts[1] ?? '')?.[1] ?? null
  }
  return null
}

function expressions(scope: Scope): Completion[] {
  const { o, at } = scope
  const options: Completion[] = []

  const fn = enclosingFunction(scope)
  if (fn)
    for (const param of fn.params)
      options.push({
        label: param,
        type: 'variable',
        detail: 'parameter',
        info: `A parameter of ${fn.name}().`,
        boost: RANK.local,
      })
  for (const binding of o.bindings)
    if (binding.scope && contains(binding.scope, at) && binding.end !== null && binding.end < at)
      options.push({
        label: binding.name,
        type: 'variable',
        detail: 'let',
        info: `Bound by the let on line ${lineOf(scope, binding.at)}.`,
        boost: RANK.local,
      })
  for (const match of matchesAt(o, at))
    for (const wildcard of match.wildcards)
      options.push({
        label: wildcard.name,
        type: 'variable',
        detail: wildcard.recursive ? 'wildcard · path' : 'wildcard · string',
        info: wildcard.recursive
          ? `The rest of the path below match ${match.path}, as a path.`
          : `The {${wildcard.name}} segment of match ${match.path}.`,
        boost: RANK.wildcard,
      })

  for (const f of o.functions) {
    if (!f.name || (f.scope && !contains(f.scope, at))) continue
    // A function cannot call itself.
    if (f.body && contains(f.body, at)) continue
    options.push({
      label: f.name,
      type: 'function',
      detail: `(${f.params.join(', ')})`,
      info: `Declared on line ${lineOf(scope, f.at)}.`,
      boost: RANK.userFunction,
      apply: callApply(f.name, f.params),
    })
  }

  const storage = scope.dialect === 'storage'
  for (const entry of storage ? STORAGE_VARIABLES : GLOBAL_VARIABLES)
    options.push({
      label: entry.name,
      type: 'variable',
      detail: showKind(entry.returns),
      info: entry.info,
      boost: RANK.variable,
    })
  const database = databaseName(scope)
  for (const entry of GLOBAL_FUNCTION_ENTRIES) {
    // Storage reads documents through `firestore.`, not with these.
    if (storage && DOCUMENT_FUNCTIONS.has(entry.name)) continue
    const option = callCompletion(entry, 'function', RANK.globalFunction)
    if (DOCUMENT_FUNCTIONS.has(entry.name)) {
      const root = database ? `$(${database})` : '(default)'
      option.apply = applyCall(
        entry.name,
        `${entry.name}(/databases/${root}/documents/\${path})\${}`,
      )
    }
    options.push(option)
  }
  for (const entry of storage ? [...NAMESPACE_ENTRIES, FIRESTORE_NAMESPACE] : NAMESPACE_ENTRIES)
    options.push({ label: entry.name, type: 'namespace', info: entry.info, boost: RANK.namespace })
  for (const entry of LITERALS)
    options.push({ label: entry.name, type: 'constant', info: entry.info, boost: RANK.literal })

  // A parameter or a wildcard can shadow a later name; offer each once.
  const seen = new Set<string>()
  return options.filter((option) => !seen.has(option.label) && Boolean(seen.add(option.label)))
}

/**
 * Inserts a call with its parameters as fields to tab through, or just
 * the name when a parenthesis already follows it.
 */
function applyCall(name: string, template: string): NonNullable<Completion['apply']> {
  const insert = snippet(template)
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    if (view.state.sliceDoc(to, to + 1) === '(') {
      view.dispatch({
        ...insertCompletionText(view.state, name, from, to),
        annotations: pickedCompletion.of(completion),
      })
      return
    }
    insert(view, completion, from, to)
  }
}

function callApply(name: string, params: readonly string[]): NonNullable<Completion['apply']> {
  const fields = params.map((param) => `\${${param}}`).join(', ')
  return applyCall(name, `${name}(${fields})\${}`)
}

function callCompletion(
  entry: Entry,
  type: string,
  boost: number,
  owners?: readonly Kind[],
): Completion {
  const sig = signature(entry)
  return {
    label: entry.name,
    type,
    detail: owners ? `${sig} · ${owners.map(showKind).join(', ')}` : sig,
    info: entry.info,
    boost,
    ...(entry.params ? { apply: callApply(entry.name, entry.params) } : {}),
  }
}

// --- Members -----------------------------------------------------------

const NAME_STYLES: ReadonlySet<Style> = new Set([
  'variableName',
  'builtin',
  'call',
  'builtinCall',
  'method',
  'property',
  'namespace',
  'bool',
  'null',
])
const BRACKET_STYLES: ReadonlySet<Style> = new Set([
  'paren',
  'interpolation',
  'squareBracket',
  'brace',
])
const OPENERS: ReadonlySet<string> = new Set(['(', '[', '{', '$('])

/** The index of the bracket that opens the one closing at `close`, or -1. */
function matchBack(code: readonly Token[], close: number): number {
  let depth = 0
  for (let i = close; i >= 0; i--) {
    const t = code[i]!
    if (!BRACKET_STYLES.has(t.style)) continue
    if (OPENERS.has(t.text)) {
      depth--
      if (depth === 0) return i
    } else {
      depth++
    }
  }
  return -1
}

function endsOperand(t: Token): boolean {
  return (
    NAME_STYLES.has(t.style) ||
    t.style === 'string' ||
    t.style === 'wildcard' ||
    t.text === ')' ||
    t.text === ']'
  )
}

interface Link {
  kind: 'name' | 'call' | 'index'
  name: string
  args: readonly Token[]
}

type Primary = 'name' | 'string' | 'bytes' | 'list' | 'map' | 'number' | 'other'

/**
 * The expression a dot is applied to, read backwards from the dot: a
 * primary (a name, a literal) and the names, calls and indexes after it.
 */
function receiverBefore(code: readonly Token[], dot: number): { primary: Primary; links: Link[] } {
  const links: Link[] = []
  let primary: Primary = 'other'
  let j = dot - 1
  while (j >= 0) {
    const t = code[j]!
    if (t.text === ')' && t.style === 'paren') {
      const open = matchBack(code, j)
      const callee = code[open - 1]
      // A parenthesised expression rather than a call: its type is not followed.
      if (open < 0 || code[open]!.text !== '(' || !callee || !NAME_STYLES.has(callee.style)) break
      links.push({ kind: 'call', name: '', args: code.slice(open + 1, j) })
      j = open - 1
      continue
    }
    if (t.text === ']' && t.style === 'squareBracket') {
      const open = matchBack(code, j)
      if (open < 0) break
      const before = code[open - 1]
      if (before && endsOperand(before)) {
        links.push({ kind: 'index', name: '', args: code.slice(open + 1, j) })
        j = open - 1
        continue
      }
      primary = 'list'
      break
    }
    if (NAME_STYLES.has(t.style)) {
      links.push({ kind: 'name', name: t.text, args: [] })
      if (code[j - 1]?.style === 'derefOperator') {
        j -= 2
        continue
      }
      primary = 'name'
      break
    }
    if (t.style === 'string') {
      let first = j
      while (
        first > 0 &&
        (code[first - 1]!.style === 'string' || code[first - 1]!.style === 'escape')
      )
        first--
      primary = code[first]!.text.startsWith('b') ? 'bytes' : 'string'
    } else if (t.style === 'number') {
      primary = 'number'
    } else if (t.text === '}' && t.style === 'brace') {
      primary = 'map'
    }
    break
  }
  links.reverse()
  return { primary, links }
}

/**
 * The collection pattern of a document path written as a literal, as in
 * `get(/databases/$(database)/documents/users/$(uid))` → "users".
 */
function patternOfPath(args: readonly Token[]): string | null {
  let text = ''
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!
    if (t.style === 'path') {
      text += t.text
    } else if (t.style === 'wildcard') {
      text += '*'
    } else if (t.style === 'interpolation' && t.text === '$(') {
      let depth = 0
      for (; i < args.length; i++) {
        const inner = args[i]!
        if (!BRACKET_STYLES.has(inner.style)) continue
        if (OPENERS.has(inner.text)) depth++
        else if (--depth === 0) break
      }
      text += '*'
    } else {
      return null
    }
  }
  const parts = text.split('/').filter(Boolean)
  if (parts[0] !== 'databases' || parts[2] !== 'documents') return null
  const rest = parts.slice(3)
  if (rest.length === 0 || rest.length % 2 !== 0) return null
  return rest
    .slice(0, -1)
    .map((part) => (part.includes('*') ? '*' : part))
    .join('/')
}

function documentPatternAt(scope: Scope): string | null {
  const path = matchPathIn(scope.o, scope.at)
  return path ? documentPattern(path) : null
}

function identifierType(scope: Scope, name: string): Ty {
  if (scope.dialect === 'storage') {
    if (name === 'request') return ty('request')
    if (name === 'resource') return ty('object')
  } else {
    if (name === 'request' || name === 'resource') return ty(name, documentPatternAt(scope))
    // Firestore's rules have no `firestore` namespace: it is just a name there.
    if (name === 'firestore') return ty('unknown')
  }
  if (NAMESPACES.has(name)) return ty(`ns:${name}` as Kind)
  if (name === 'true' || name === 'false') return ty('bool')
  if (name === 'null') return ty('null')
  for (const match of matchesAt(scope.o, scope.at))
    for (const wildcard of match.wildcards)
      if (wildcard.name === name) return ty(wildcard.recursive ? 'path' : 'string')
  return ty('unknown')
}

function globalCallType(name: string, args: readonly Token[], dialect: RulesDialect): Ty {
  // Storage has no global document functions: `firestore.get()` instead.
  if (dialect === 'storage' && DOCUMENT_FUNCTIONS.has(name)) return ty('unknown')
  if (name === 'get' || name === 'getAfter') return ty('resource', patternOfPath(args))
  const entry = GLOBAL_FUNCTION_ENTRIES.find((e) => e.name === name)
  return ty(entry ? entry.returns : 'unknown')
}

/** The properties a type has in the dialect: Storage's request and file are its own. */
function propertiesOf(kind: Kind, dialect: RulesDialect): readonly Entry[] {
  if (kind === 'object') return STORAGE_OBJECT
  if (kind === 'request' && dialect === 'storage') return STORAGE_REQUEST
  return PROPERTIES[kind] ?? []
}

function memberType(receiver: Ty, name: string, dialect: RulesDialect): Ty {
  switch (receiver.kind) {
    case 'request':
      if (name === 'resource')
        return dialect === 'storage' ? ty('object') : ty('resource', receiver.pattern)
      break
    case 'resource':
      if (name === 'data') return ty('data', receiver.pattern)
      break
    case 'token':
      if (name === 'firebase') return ty('firebase')
      break
    case 'data':
      return ty('data', receiver.pattern, `${receiver.prefix}${name}.`)
  }
  const entry = propertiesOf(receiver.kind, dialect).find((e) => e.name === name)
  return ty(entry ? entry.returns : 'unknown')
}

function methodType(receiver: Ty, name: string, args: readonly Token[]): Ty {
  // `firestore.get(/databases/(default)/documents/users/$(uid))` is a
  // document of `users`, as Firestore's own `get()` is.
  if (receiver.kind === 'ns:firestore' && name === 'get') return ty('resource', patternOfPath(args))
  if (receiver.kind.startsWith('ns:')) {
    const entry = NAMESPACE_FUNCTIONS[receiver.kind]?.find((e) => e.name === name)
    return ty(entry ? entry.returns : 'unknown')
  }
  const own = METHODS[MAP_LIKE.has(receiver.kind) ? 'map' : receiver.kind]
  const entry =
    own?.find((e) => e.name === name) ?? GENERIC_METHODS.find((g) => g.entry.name === name)?.entry
  return ty(entry ? entry.returns : 'unknown')
}

function receiverType(scope: Scope, dot: number): Ty | null {
  const { primary, links } = receiverBefore(scope.o.code, dot)
  let receiver: Ty
  let k = 0
  switch (primary) {
    case 'name': {
      const first = links[0]!
      if (links[1]?.kind === 'call') {
        receiver = globalCallType(first.name, links[1].args, scope.dialect)
        k = 2
      } else {
        receiver = identifierType(scope, first.name)
        k = 1
      }
      break
    }
    case 'number':
      return null
    case 'other':
      receiver = ty('unknown')
      break
    default:
      receiver = ty(primary)
  }
  for (; k < links.length; k++) {
    const link = links[k]!
    if (link.kind !== 'name') {
      receiver = ty('unknown')
    } else if (links[k + 1]?.kind === 'call') {
      receiver = methodType(receiver, link.name, links[k + 1]!.args)
      k++
    } else {
      receiver = memberType(receiver, link.name, scope.dialect)
    }
  }
  return receiver
}

function propertyCompletion(entry: Entry, boost = 0): Completion {
  return {
    label: entry.name,
    type: 'property',
    detail: showKind(entry.returns),
    info: entry.info,
    boost,
  }
}

/** A name that `.name` cannot reach is reached as `['name']` instead. */
function keyApply(name: string): NonNullable<Completion['apply']> {
  const quoted = `['${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const start = view.state.sliceDoc(from - 1, from) === '.' ? from - 1 : from
    view.dispatch({
      ...insertCompletionText(view.state, quoted, start, to),
      annotations: pickedCompletion.of(completion),
    })
  }
}

function keyCompletion(name: string, completion: Completion): Completion {
  return IDENTIFIER.test(name) && !RESERVED.has(name)
    ? completion
    : { ...completion, apply: keyApply(name) }
}

function ownMethods(kind: Kind, boost: number): Completion[] {
  return (METHODS[MAP_LIKE.has(kind) ? 'map' : kind] ?? []).map((entry) =>
    callCompletion(entry, 'method', boost),
  )
}

function otherMethods(kind: Kind, boost: number): Completion[] {
  const own = new Set((METHODS[MAP_LIKE.has(kind) ? 'map' : kind] ?? []).map((e) => e.name))
  return GENERIC_METHODS.filter((g) => !own.has(g.entry.name)).map((g) => generic(g, boost))
}

function generic(method: GenericMethod, boost: number): Completion {
  return callCompletion(method.entry, 'method', boost, method.owners)
}

function members(scope: Scope, dot: number): Answer {
  const receiver = receiverType(scope, dot)
  if (!receiver) return null
  const from = scope.at
  switch (receiver.kind) {
    case 'request':
    case 'auth':
    case 'query':
    case 'resource':
    case 'firebase':
    case 'object':
      return result(
        from,
        propertiesOf(receiver.kind, scope.dialect).map((entry) => propertyCompletion(entry)),
      )
    case 'token':
      return tokenMembers(scope)
    case 'data':
      return dataMembers(scope, receiver)
    case 'metadata':
      return metadataMembers(scope)
    case 'ns:firestore':
      if (scope.dialect !== 'storage') return null
      return result(
        from,
        (NAMESPACE_FUNCTIONS['ns:firestore'] ?? []).map((entry) => {
          const option = callCompletion(entry, 'function', 0)
          option.apply = applyCall(
            entry.name,
            `${entry.name}(/databases/(default)/documents/\${path})\${}`,
          )
          return option
        }),
      )
    case 'ns:math':
    case 'ns:timestamp':
    case 'ns:duration':
    case 'ns:latlng':
    case 'ns:hashing':
      return result(
        from,
        (NAMESPACE_FUNCTIONS[receiver.kind] ?? []).map((entry) =>
          callCompletion(entry, 'function', 0),
        ),
      )
    case 'int':
    case 'float':
    case 'number':
    case 'bool':
    case 'null':
      return null
    case 'unknown':
      return result(
        from,
        GENERIC_METHODS.map((method) => generic(method, 0)),
      )
    default:
      return result(from, [
        ...ownMethods(receiver.kind, RANK.own),
        ...otherMethods(receiver.kind, RANK.other),
      ])
  }
}

/**
 * The token's claims: the standard ones, then the custom claim keys users
 * carry (asked of the page, which may have to ask the engine), then the
 * map's methods.
 */
function tokenMembers(scope: Scope): Answer {
  const build = (custom: readonly string[]): Result =>
    result(scope.at, [...claims(custom), ...ownMethods('map', RANK.methods)])
  let custom: readonly string[] | Promise<readonly string[]>
  try {
    custom = scope.options.claims?.() ?? []
  } catch {
    return build([])
  }
  if (isPromiseLike(custom))
    return Promise.resolve(custom).then(
      (found) => build(Array.isArray(found) ? found : []),
      () => build([]),
    )
  return build(Array.isArray(custom) ? custom : [])
}

function claims(custom: readonly string[]): Completion[] {
  const standard = PROPERTIES.token ?? []
  const known = new Set(standard.map((entry) => entry.name))
  return [
    ...standard.map((entry) => propertyCompletion(entry, RANK.field)),
    ...[...new Set(custom)]
      .filter((name) => typeof name === 'string' && name !== '' && !known.has(name))
      .map((name) =>
        keyCompletion(name, {
          label: name,
          type: 'property',
          detail: 'custom claim',
          info: 'A custom claim set on Auth users in this project.',
          boost: RANK.field,
        }),
      ),
  ]
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

/**
 * A document's map: the fields seen in documents of its collection, then
 * the map's methods. Below a field, the fields nested inside it — and if
 * nothing is, the field is not known to be a map, so every method is
 * offered.
 */
function dataMembers(scope: Scope, receiver: Ty): Answer {
  const { pattern, prefix } = receiver
  const build = (names: readonly string[]): Result => {
    const heads = new Map<string, boolean>()
    for (const name of names) {
      if (typeof name !== 'string' || !name.startsWith(prefix)) continue
      const rest = name.slice(prefix.length)
      const dot = rest.indexOf('.')
      const head = dot < 0 ? rest : rest.slice(0, dot)
      if (head) heads.set(head, (heads.get(head) ?? false) || dot >= 0)
    }
    const fields = [...heads].map(([head, nested]) =>
      keyCompletion(head, {
        label: head,
        type: 'property',
        detail: nested ? 'map field' : 'field',
        info: `${prefix}${head}, seen in documents of ${pattern ?? ''}.`,
        boost: RANK.field,
      }),
    )
    const isMap = prefix === '' || heads.size > 0
    const methods = isMap
      ? ownMethods('map', RANK.methods)
      : GENERIC_METHODS.map((method) => generic(method, 0))
    return result(scope.at, [...fields, ...methods])
  }

  if (!pattern || !scope.options.fields) return build([])
  let names: readonly string[] | Promise<readonly string[]>
  try {
    names = scope.options.fields(pattern)
  } catch {
    return build([])
  }
  if (isPromiseLike(names))
    return Promise.resolve(names).then(
      (found) => build(Array.isArray(found) ? found : []),
      () => build([]),
    )
  return build(Array.isArray(names) ? names : [])
}

/**
 * The folder a Storage match starts with, which custom metadata keys are
 * sampled from: `match /b/{bucket}/o { match /users/{uid}/{f=**} }` → `users/`,
 * the bucket's root (`''`) when the first segment is a wildcard.
 */
export function storageFolderAt(o: Outline, pos: number): string {
  const all = matchesAt(o, pos).flatMap((b) => b.path.split('/').filter((part) => part !== ''))
  if (all[0] !== 'b' || all[2] !== 'o') return ''
  const literal: string[] = []
  for (const part of all.slice(3)) {
    if (part.startsWith('{')) break
    literal.push(part)
  }
  return literal.length === 0 ? '' : `${literal.join('/')}/`
}

/**
 * A Storage file's custom metadata: the keys seen on files under the
 * match's folder, then the map's methods.
 */
function metadataMembers(scope: Scope): Answer {
  const build = (names: readonly string[]): Result => {
    const keys = [...new Set(names)].filter((name) => typeof name === 'string' && name !== '')
    return result(scope.at, [
      ...keys.map((key) =>
        keyCompletion(key, {
          label: key,
          type: 'property',
          detail: 'metadata key',
          info: 'A custom metadata key seen on files here.',
          boost: RANK.field,
        }),
      ),
      ...ownMethods('map', RANK.methods),
    ])
  }
  if (!scope.options.metadataKeys) return build([])
  let names: readonly string[] | Promise<readonly string[]>
  try {
    names = scope.options.metadataKeys(storageFolderAt(scope.o, scope.at))
  } catch {
    return build([])
  }
  if (isPromiseLike(names))
    return Promise.resolve(names).then(
      (found) => build(Array.isArray(found) ? found : []),
      () => build([]),
    )
  return build(Array.isArray(names) ? names : [])
}
