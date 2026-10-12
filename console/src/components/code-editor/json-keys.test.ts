import {
  CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { json, jsonLanguage } from '@codemirror/lang-json'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { jsonKeySource, keyEdit, keyOptions, topLevelKeyAt } from './json-keys'

const CARET = '‸'

function at(source: string): { text: string; pos: number } {
  const pos = source.indexOf(CARET)
  if (pos < 0) throw new Error('no caret')
  return { text: source.slice(0, pos) + source.slice(pos + CARET.length), pos }
}

function slotOf(source: string) {
  const { text, pos } = at(source)
  return topLevelKeyAt(text, pos)
}

describe('where a top-level key goes', () => {
  it('inside a key’s quotes, with what is typed before the cursor', () => {
    expect(slotOf('{ "ro‸" }')).toMatchObject({
      from: 3,
      end: 5,
      typed: 'ro',
      quoted: true,
      closed: true,
    })
    expect(slotOf('{\n  "role": "admin",\n  "pl‸')).toMatchObject({
      typed: 'pl',
      quoted: true,
      closed: false,
    })
  })

  it('on a bare word typed where a key goes', () => {
    expect(slotOf('{ ro‸ }')).toMatchObject({ from: 2, end: 4, typed: 'ro', quoted: false })
  })

  it('in the space after the brace or a comma', () => {
    expect(slotOf('{‸}')).toMatchObject({ from: 1, end: 1, typed: '', quoted: false })
    expect(slotOf('{ "a": 1, ‸ }')).toMatchObject({ typed: '', quoted: false })
    expect(slotOf('{\n  "a": 1,\n  ‸\n}')).toMatchObject({ typed: '' })
  })

  it('nowhere else: values, nested objects and arrays, after a key, outside the object', () => {
    expect(slotOf('{ "a": "x‸" }')).toBeUndefined()
    expect(slotOf('{ "a": tr‸ }')).toBeUndefined()
    expect(slotOf('{ "a": { "b‸" } }')).toBeUndefined()
    expect(slotOf('{ "a": [ "b‸" ] }')).toBeUndefined()
    expect(slotOf('{ "a"‸ }')).toBeUndefined()
    expect(slotOf('{ "a" ‸: 1 }')).toBeUndefined()
    expect(slotOf('[ "a‸" ]')).toBeUndefined()
    expect(slotOf('‸')).toBeUndefined()
    expect(slotOf('{ "a": 1 }‸')).toBeUndefined()
    // Glued to the front of a key already there.
    expect(slotOf('{ ‸"a": 1 }')).toBeUndefined()
  })

  it('knows the keys the object already has, the nested ones not counted', () => {
    const slot = slotOf('{ "role": "admin", "org": { "plan": 1 }, "p‸", "beta": true }')
    expect([...(slot?.present ?? [])].toSorted()).toEqual(['beta', 'org', 'role'])
    expect(slotOf('{ "a\\"b": 1, ‸ }')?.present.has('a"b')).toBe(true)
  })
})

describe('what is offered', () => {
  it('the caller’s keys in its order, by prefix, without the ones already there', () => {
    const slot = slotOf('{ "role": "admin", "p‸" }')
    if (!slot) throw new Error('no slot')
    expect(keyOptions(slot, ['plan', 'role', 'premium', 'beta', 'plan'])).toEqual([
      'plan',
      'premium',
    ])
    expect(keyOptions({ ...slot, typed: 'P' }, ['Plan', 'plan'])).toEqual(['Plan', 'plan'])
  })
})

describe('writing the picked key', () => {
  const edit = (source: string, key: string) => {
    const { text, pos } = at(source)
    const slot = topLevelKeyAt(text, pos)
    if (!slot) throw new Error('no slot')
    const change = keyEdit(text, slot, key)
    const next = text.slice(0, change.from) + change.insert + text.slice(change.to)
    return next.slice(0, change.cursor) + CARET + next.slice(change.cursor)
  }

  it('quoted, with its colon, the cursor where the value goes', () => {
    expect(edit('{ "ro‸" }', 'role')).toBe('{ "role": ‸ }')
    expect(edit('{ ro‸ }', 'role')).toBe('{ "role": ‸ }')
    expect(edit('{‸}', 'role')).toBe('{"role": ‸}')
    expect(edit('{ "pl‸', 'plan')).toBe('{ "plan": ‸')
  })

  it('keeps a colon already there, and the whole of a key typed around the cursor', () => {
    expect(edit('{ "r‸ol": 1 }', 'role')).toBe('{ "role": ‸1 }')
    expect(edit('{ r‸o : "x" }', 'role')).toBe('{ "role": ‸"x" }')
  })

  it('escapes a key JSON must escape', () => {
    expect(edit('{ ‸ }', 'say "hi"')).toBe('{ "say \\"hi\\"": ‸ }')
  })
})

describe('in the editor', () => {
  let view: EditorView | undefined
  afterEach(() => {
    view?.destroy()
    view = undefined
  })

  function stateAt(source: string, keys: readonly string[]) {
    const { text, pos } = at(source)
    const state = EditorState.create({
      doc: text,
      selection: { anchor: pos },
      extensions: [json(), jsonLanguage.data.of({ autocomplete: jsonKeySource(() => keys) })],
    })
    return { state, pos }
  }

  async function complete(source: string, keys: readonly string[], explicit = false) {
    const { state, pos } = stateAt(source, keys)
    const sources = state.languageDataAt<CompletionSource>('autocomplete', pos)
    const results = await Promise.all(
      sources.map((ask) => ask(new CompletionContext(state, pos, explicit))),
    )
    return {
      state,
      pos,
      result: results.find((result): result is CompletionResult => result !== null) ?? null,
    }
  }

  it('offers the keys once a quote or a letter is typed, and on request anywhere a key goes', async () => {
    expect(
      (await complete('{ "‸" }', ['role', 'plan'])).result?.options.map((o) => o.label),
    ).toEqual(['role', 'plan'])
    expect((await complete('{ ‸ }', ['role'])).result).toBeNull()
    expect((await complete('{ ‸ }', ['role'], true)).result?.options.map((o) => o.label)).toEqual([
      'role',
    ])
    expect((await complete('{ "a": "‸" }', ['role'], true)).result).toBeNull()
    expect((await complete('{ "‸" }', [])).result).toBeNull()
  })

  it('writes the picked key with its colon and puts the cursor on the value', async () => {
    const { state, pos, result } = await complete('{\n  "role": "admin",\n  "p‸"\n}', [
      'role',
      'plan',
    ])
    expect(result?.options.map((o) => o.label)).toEqual(['plan'])
    view = new EditorView({ state, parent: document.body })
    const picked = result?.options[0]
    if (typeof picked?.apply !== 'function') throw new Error('no apply')
    picked.apply(view, picked, result?.from ?? pos, pos)
    expect(view.state.doc.toString()).toBe('{\n  "role": "admin",\n  "plan": \n}')
    expect(view.state.selection.main.head).toBe('{\n  "role": "admin",\n  "plan": '.length)
  })
})
