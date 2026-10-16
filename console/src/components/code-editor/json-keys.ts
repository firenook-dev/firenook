// Completion of a JSON document's top-level keys from a list the caller
// knows (the custom claim keys other users carry), for `jsonCompletion`.
//
// Where a key can be typed is read from the text by a forgiving scan, as
// the editor's other annotators are: the document is being typed, so it is
// rarely valid JSON at the moment completion is asked for. Only the
// outermost object's keys are offered, never a nested object's, and never
// a key the object already has. Picking one writes it quoted, with its
// colon, and leaves the cursor where the value goes.
//
// Plain functions over strings and numbers, so they are unit-tested
// without an editor; the CodeMirror source at the end is a thin wrapper,
// and only types are imported from CodeMirror here.

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'

/** Where a top-level key is being typed. */
export interface JsonKeySlot {
  /** Where the key's text starts: after its opening quote, or where a bare word starts. */
  from: number
  /** Where the key's text ends: before its closing quote (or at the line's end), or the bare word's end. */
  end: number
  /** What is typed of it before the cursor. */
  typed: string
  /** Inside quotes. */
  quoted: boolean
  /** A quote closes it. */
  closed: boolean
  /** The keys the object already has, the one being typed left out. */
  present: ReadonlySet<string>
}

interface Token {
  kind: 'open' | 'close' | 'colon' | 'comma' | 'string' | 'bare'
  from: number
  to: number
  /** `open`: the bracket; `string`: whether a quote closes it. */
  object?: boolean
  closed?: boolean
}

interface Frame {
  kind: 'object' | 'array'
  expect: 'key' | 'colon' | 'value' | 'comma'
}

const SPACE = /\s/
const BARE_END = /[\s,:{}[\]"]/

/**
 * The text's tokens, read forgivingly: an unclosed string ends at its
 * line's end, and anything that is not structure or a string is a bare
 * word (a literal, a number, or a key typed without its quotes yet).
 */
function* tokens(text: string): Generator<Token> {
  let at = 0
  while (at < text.length) {
    const character = text[at] as string
    if (SPACE.test(character)) {
      at += 1
    } else if (character === '{' || character === '[') {
      yield { kind: 'open', from: at, to: at + 1, object: character === '{' }
      at += 1
    } else if (character === '}' || character === ']') {
      yield { kind: 'close', from: at, to: at + 1 }
      at += 1
    } else if (character === ':' || character === ',') {
      yield { kind: character === ':' ? 'colon' : 'comma', from: at, to: at + 1 }
      at += 1
    } else if (character === '"') {
      let end = at + 1
      let closed = false
      while (end < text.length) {
        const inner = text[end]
        if (inner === '\\') end += 2
        else if (inner === '"') {
          end += 1
          closed = true
          break
        } else if (inner === '\n') break
        else end += 1
      }
      const to = Math.min(end, text.length)
      yield { kind: 'string', from: at, to, closed }
      at = to
    } else {
      let end = at + 1
      while (end < text.length && !BARE_END.test(text[end] as string)) end += 1
      yield { kind: 'bare', from: at, to: end }
      at = end
    }
  }
}

function decoded(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/** The outermost object, expecting a key: the only place a key is offered. */
function atTopKey(stack: readonly Frame[]): boolean {
  return stack.length === 1 && stack[0]?.kind === 'object' && stack[0].expect === 'key'
}

/**
 * The top-level key under the cursor at `position`, when the cursor stands
 * where the outermost object takes a key: inside a key's quotes, on a bare
 * word typed where a key goes, or in the space between keys. Nothing
 * elsewhere — in a value, in a nested object or array, outside the object.
 */
export function topLevelKeyAt(text: string, position: number): JsonKeySlot | undefined {
  const stack: Frame[] = []
  const present = new Set<string>()
  let slot: Omit<JsonKeySlot, 'present'> | undefined
  /** Whether the space the cursor stands in takes a key; undefined until the scan passes it. */
  let gap: boolean | undefined
  for (const token of tokens(text)) {
    if (gap === undefined && token.from >= position) gap = atTopKey(stack)
    else if (gap === undefined && token.from < position && position < token.to) gap = false
    const frame = stack.at(-1)
    const topKey = atTopKey(stack)
    switch (token.kind) {
      case 'open':
        stack.push(
          token.object ? { kind: 'object', expect: 'key' } : { kind: 'array', expect: 'value' },
        )
        break
      case 'close':
        stack.pop()
        if (stack.length > 0) (stack.at(-1) as Frame).expect = 'comma'
        break
      case 'colon':
        if (frame?.kind === 'object' && frame.expect === 'colon') frame.expect = 'value'
        break
      case 'comma':
        if (frame) frame.expect = frame.kind === 'object' ? 'key' : 'value'
        break
      case 'string': {
        if (topKey) {
          const close = token.closed ? token.to - 1 : token.to
          if (position > token.from && position <= close)
            slot = {
              from: token.from + 1,
              end: close,
              typed: text.slice(token.from + 1, position),
              quoted: true,
              closed: token.closed === true,
            }
          else if (token.closed) {
            const key = decoded(text.slice(token.from, token.to))
            if (key !== undefined) present.add(key)
          }
        }
        if (frame)
          frame.expect = frame.kind === 'object' && frame.expect === 'key' ? 'colon' : 'comma'
        break
      }
      case 'bare':
        if (topKey && position >= token.from && position <= token.to)
          slot = {
            from: token.from,
            end: token.to,
            typed: text.slice(token.from, position),
            quoted: false,
            closed: false,
          }
        if (frame)
          frame.expect = frame.kind === 'object' && frame.expect === 'key' ? 'colon' : 'comma'
        break
    }
  }
  if (slot) return { ...slot, present }
  if (gap === undefined) gap = atTopKey(stack)
  // A new key goes in space, or right before the object's end — never
  // glued to the front of something already there.
  const next = text[position]
  if (!gap || (next !== undefined && !SPACE.test(next) && next !== '}')) return undefined
  return { from: position, end: position, typed: '', quoted: false, closed: false, present }
}

/** The edit that writes `key` into `slot`: quoted, its colon after it, the cursor where the value goes. */
export function keyEdit(
  text: string,
  slot: JsonKeySlot,
  key: string,
): { from: number; to: number; insert: string; cursor: number } {
  // Inside quotes the key is written again whole, its quotes with it.
  const from = slot.quoted ? slot.from - 1 : slot.from
  let to = slot.quoted && slot.closed ? slot.end + 1 : slot.end
  // A colon already there is kept in place of a new one, with the space
  // after it.
  let rest = to
  while (rest < text.length && (text[rest] === ' ' || text[rest] === '\t')) rest += 1
  if (text[rest] === ':') {
    to = rest + 1
    while (to < text.length && (text[to] === ' ' || text[to] === '\t')) to += 1
  }
  const insert = `${JSON.stringify(key)}: `
  return { from, to, insert, cursor: from + insert.length }
}

/** The keys to offer in `slot`, in the caller's order: those that start with what is typed and are not there yet. */
export function keyOptions(slot: JsonKeySlot, keys: readonly string[]): string[] {
  const typed = slot.typed.toLowerCase()
  const seen = new Set<string>()
  const offered: string[] = []
  for (const key of keys) {
    if (seen.has(key) || slot.present.has(key)) continue
    seen.add(key)
    if (key.toLowerCase().startsWith(typed)) offered.push(key)
  }
  return offered
}

/**
 * The CodeMirror completion source: the caller's keys where a top-level key
 * goes. Unprompted it answers once something of a key is typed (a quote or
 * a letter); Ctrl-Space asks in any key position. `keys` is read on each
 * completion, so a new list never rebuilds the editor.
 */
export function jsonKeySource(keys: () => readonly string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const list = keys()
    if (list.length === 0) return null
    const text = context.state.doc.toString()
    const slot = topLevelKeyAt(text, context.pos)
    if (!slot) return null
    if (!context.explicit && !slot.quoted && slot.typed === '') return null
    const offered = keyOptions(slot, list)
    if (offered.length === 0) return null
    return {
      from: slot.from,
      to: context.pos,
      options: offered.map((key) => ({
        label: key,
        type: 'property',
        apply: (view: EditorView) => {
          const now = view.state.doc.toString()
          const here = topLevelKeyAt(now, view.state.selection.main.head) ?? slot
          const edit = keyEdit(now, here, key)
          view.dispatch({
            changes: { from: edit.from, to: edit.to, insert: edit.insert },
            selection: { anchor: edit.cursor },
            userEvent: 'input.complete',
          })
        },
      })),
      validFor: /^[\w$.-]*$/,
    }
  }
}
