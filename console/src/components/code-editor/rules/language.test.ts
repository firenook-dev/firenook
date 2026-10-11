import { CompletionContext, type CompletionSource } from '@codemirror/autocomplete'
import {
  ensureSyntaxTree,
  foldable,
  getIndentation,
  matchBrackets,
  syntaxTree,
} from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import { describe, expect, it } from 'vitest'
import { RULES } from './fixture'
import { documentPattern, enclosingMatchPath, rulesLanguage, wildcardsAt } from './index'
import { rulesStreamLanguage } from './language'
import { lex } from './scan'

function editor(doc: string) {
  return EditorState.create({ doc, extensions: [rulesLanguage()] })
}

describe('highlighting', () => {
  // The most specific tag wins, so each construct gets its own class here
  // even where a theme would let it fall back to the common tag.
  const highlighter = tagHighlighter([
    { tag: tags.keyword, class: 'keyword' },
    { tag: tags.controlKeyword, class: 'control' },
    { tag: tags.definitionKeyword, class: 'definitionKeyword' },
    { tag: tags.operatorKeyword, class: 'operatorKeyword' },
    { tag: tags.special(tags.keyword), class: 'operation' },
    { tag: tags.lineComment, class: 'lineComment' },
    { tag: tags.blockComment, class: 'blockComment' },
    { tag: tags.string, class: 'string' },
    { tag: tags.escape, class: 'escape' },
    { tag: tags.special(tags.string), class: 'path' },
    { tag: tags.special(tags.variableName), class: 'wildcard' },
    { tag: tags.special(tags.brace), class: 'interpolation' },
    { tag: tags.number, class: 'number' },
    { tag: tags.bool, class: 'bool' },
    { tag: tags.null, class: 'null' },
    { tag: tags.variableName, class: 'variable' },
    { tag: tags.standard(tags.variableName), class: 'builtin' },
    { tag: tags.definition(tags.variableName), class: 'definition' },
    { tag: tags.function(tags.variableName), class: 'call' },
    { tag: tags.function(tags.definition(tags.variableName)), class: 'functionDef' },
    { tag: tags.propertyName, class: 'property' },
    { tag: tags.function(tags.propertyName), class: 'method' },
    { tag: tags.namespace, class: 'namespace' },
    { tag: tags.typeName, class: 'type' },
    { tag: tags.operator, class: 'operator' },
    { tag: tags.compareOperator, class: 'compare' },
    { tag: tags.logicOperator, class: 'logic' },
    { tag: tags.derefOperator, class: 'deref' },
    { tag: tags.brace, class: 'brace' },
    { tag: tags.paren, class: 'paren' },
    { tag: tags.separator, class: 'separator' },
  ])

  function classes(text: string): Map<string, string> {
    const tree = rulesStreamLanguage.parser.parse(text)
    const found = new Map<string, string>()
    highlightTree(tree, highlighter, (from, to, cls) => {
      const slice = text.slice(from, to)
      if (!found.has(slice)) found.set(slice, cls)
    })
    return found
  }

  it('gives each construct of a ruleset its tag', () => {
    const seen = classes(RULES)
    expect(seen.get('rules_version')).toBe('keyword')
    expect(seen.get('match')).toBe('keyword')
    expect(seen.get('return')).toBe('control')
    expect(seen.get('function')).toBe('definitionKeyword')
    expect(seen.get('is')).toBe('operatorKeyword')
    expect(seen.get('create')).toBe('operation')
    expect(seen.get('/databases/')).toBe('path')
    expect(seen.get('{database}')).toBe('wildcard')
    expect(seen.get('{rest=**}')).toBe('wildcard')
    expect(seen.get('$(')).toBe('interpolation')
    expect(seen.get('signedIn')).toBe('functionDef')
    expect(seen.get('request')).toBe('builtin')
    expect(seen.get('auth')).toBe('property')
    expect(seen.get('keys')).toBe('method')
    expect(seen.get('profile')).toBe('definition')
    expect(seen.get('duration')).toBe('namespace')
    expect(seen.get('string')).toBe('type')
    expect(seen.get("'admin'")).toBe('string')
    expect(seen.get("\\'")).toBe('escape')
    expect(seen.get('1000.50')).toBe('number')
    expect(seen.get('null')).toBe('null')
    expect(seen.get('// Public posts, any depth below.')).toBe('lineComment')
    expect(seen.get('==')).toBe('compare')
    expect(seen.get('&&')).toBe('logic')
    expect(seen.get('.')).toBe('deref')
    expect(seen.get(';')).toBe('separator')
  })

  it('tags a call to a function the ruleset declares, and a plain name', () => {
    const seen = classes('allow read: if isOwner() && uid == x;')
    expect(seen.get('isOwner')).toBe('call')
    expect(seen.get('uid')).toBe('variable')
  })
})

describe('the language', () => {
  it('declares its comment tokens and brackets', () => {
    const state = editor(RULES)
    expect(state.languageDataAt('commentTokens', 10)).toContainEqual({
      line: '//',
      block: { open: '/*', close: '*/' },
    })
    expect(state.languageDataAt<{ brackets: string[] }>('closeBrackets', 10)[0]?.brackets).toEqual([
      '(',
      '[',
      '{',
      "'",
      '"',
    ])
    expect(state.languageDataAt('autocomplete', 10)).toHaveLength(1)
  })

  it('indents by braces', () => {
    const text = 'service cloud.firestore {\nmatch /a/{b} {\nallow read: if x\n&& y;\n}\n}'
    const state = EditorState.create({ doc: text, extensions: [rulesLanguage()] })
    const lineIndent = (n: number) => getIndentation(state, state.doc.line(n).from)
    expect(lineIndent(2)).toBe(2)
    expect(lineIndent(3)).toBe(4)
    expect(lineIndent(4)).toBe(6)
    expect(lineIndent(5)).toBe(2)
    expect(lineIndent(6)).toBe(0)
  })

  it('folds brace blocks from the line that opens them', () => {
    const state = editor(RULES)
    const lineOf = (needle: string) => state.doc.lineAt(RULES.indexOf(needle))
    const service = lineOf('service cloud.firestore')
    const range = foldable(state, service.from, service.to)
    expect(range).not.toBeNull()
    expect(state.sliceDoc(range!.from - 1, range!.from)).toBe('{')
    expect(state.sliceDoc(range!.to, range!.to + 1)).toBe('}')
    expect(range!.to).toBe(RULES.lastIndexOf('}'))

    const orders = lineOf('match /orders/{orderId}')
    const inner = foldable(state, orders.from, orders.to)
    expect(state.sliceDoc(inner!.from, inner!.to)).toContain('allow delete')
    // A one-line block does not fold, nor does a line without one.
    const allow = lineOf('allow read: if isOwner() ||')
    expect(foldable(state, allow.from, allow.to)).toBeNull()
    const comment = lineOf('admins can read')
    expect(foldable(state, comment.from, comment.to)).toBeNull()
  })

  it('matches block braces past the braces of wildcards', () => {
    const text = 'match /users/{uid} {\n  allow read: if f({"a": 1});\n}'
    const state = editor(text)
    expect(syntaxTree(state).length).toBe(text.length)
    const open = text.indexOf(' {') + 1
    const match = matchBrackets(state, open, 1)
    expect(match?.matched).toBe(true)
    expect(match?.end?.from).toBe(text.length - 1)
    const wild = matchBrackets(state, text.indexOf('{uid'), 1)
    expect(wild?.end?.from).toBe(text.indexOf('}'))
  })
})

/** A small fixed-seed generator, so a failure can be replayed. */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SHARDS = [
  '/*',
  '*/',
  "'",
  '"',
  '\\',
  '$(',
  ')',
  '{',
  '}',
  '{x=**',
  '/',
  '.',
  '//',
  'match /',
  'allow ',
  ':',
  ';',
  '\n',
  "b'",
  '(default)',
]

describe('half-typed text', () => {
  it('never throws on truncated or damaged rulesets', async () => {
    const next = random(20261012)
    const answers: unknown[] = []
    for (let round = 0; round < 250; round++) {
      let text = RULES.slice(0, Math.floor(next() * (RULES.length + 1)))
      if (round % 3 === 1) {
        // Cut a piece out of the middle as well.
        const from = Math.floor(next() * text.length)
        text = text.slice(0, from) + text.slice(from + Math.floor(next() * 40))
      } else if (round % 3 === 2) {
        const at = Math.floor(next() * (text.length + 1))
        const shard = SHARDS[Math.floor(next() * SHARDS.length)]!
        text = text.slice(0, at) + shard + text.slice(at)
      }

      const tokens = lex(text)
      for (let i = 1; i < tokens.length; i++)
        expect(tokens[i]!.from).toBeGreaterThanOrEqual(tokens[i - 1]!.to)

      const state = EditorState.create({
        doc: text,
        extensions: [rulesLanguage({ fields: async () => ['a', 'b.c'], claims: () => ['admin'] })],
      })
      expect(ensureSyntaxTree(state, text.length, 5000)?.length).toBe(text.length)
      const pos = Math.floor(next() * (text.length + 1))
      for (const at of [pos, text.length]) {
        getIndentation(state, at)
        enclosingMatchPath(text, at)
        wildcardsAt(text, at)
        const path = enclosingMatchPath(text, at)
        if (path) documentPattern(path)
        const [source] = state.languageDataAt<CompletionSource>('autocomplete', at)
        answers.push(source!(new CompletionContext(state, at, true)))
        answers.push(source!(new CompletionContext(state, at, false)))
      }
      for (let n = 1; n <= state.doc.lines; n++) {
        const line = state.doc.line(n)
        foldable(state, line.from, line.to)
      }
    }
    // Completion may answer later, when fields arrive; none of it may fail.
    await expect(Promise.all(answers)).resolves.toHaveLength(answers.length)
  })
})
