// Code shown as text, in colour: each language's parser, loaded the first
// time a block in that language is shown, and the editor's ink, so a block
// reads as the same code would in the editor. Only `use-code-highlight`
// imports this, and only dynamically: the parsers and CodeMirror's
// highlighting stay out of every route's own chunk.

import { type Language, StreamLanguage, type StreamParser } from '@codemirror/language'
import { highlightTree } from '@lezer/highlight'
import { type ReactNode, createElement } from 'react'
import { INK } from '@/components/code-editor/ink'
import type { CodeLanguage } from '@/lib/code-language'

type Parser = Language['parser']

/** A language CodeMirror writes as a stream mode rather than a grammar. */
async function streamMode(mode: Promise<StreamParser<unknown>>): Promise<Parser> {
  return StreamLanguage.define(members(await mode)).parser
}

/**
 * A word after a dot is a member, whatever the mode calls it: Dart's
 * `.set(` is no keyword. Go's mode calls a lone dot a number.
 */
function members<State>(mode: StreamParser<State>): StreamParser<State> {
  return {
    ...mode,
    token(stream, state) {
      const style = mode.token(stream, state)
      if (style === 'number' && stream.current() === '.') return null
      const afterDot = stream.start > 0 && stream.string.charAt(stream.start - 1) === '.'
      return afterDot && (style === 'keyword' || style === 'builtin') ? null : style
    },
  }
}

/**
 * Environment variables as a `.env` file or the console's snippets write
 * them: `NAME=value`, then an optional `# comment`. The name takes the
 * key's ink, as a JSON key does, and the value the string's.
 */
const DOTENV: StreamParser<{ value: boolean }> = {
  name: 'dotenv',
  startState: () => ({ value: false }),
  token(stream, state) {
    if (stream.sol()) state.value = false
    if (stream.eatSpace()) return null
    if (stream.peek() === '#') {
      stream.skipToEnd()
      return 'comment'
    }
    if (state.value) {
      state.value = false
      stream.match(/^("[^"]*"|'[^']*'|\S+)/)
      return 'string'
    }
    if (stream.match(/^export(?=\s)/)) return 'keyword'
    if (stream.match(/^[A-Za-z_][\w.]*/)) return 'propertyName'
    if (stream.eat('=')) {
      state.value = true
      return 'operator'
    }
    stream.next()
    return null
  },
}

const PARSERS: Record<CodeLanguage, () => Promise<Parser>> = {
  js: async () => (await import('@codemirror/lang-javascript')).javascriptLanguage.parser,
  ts: async () => (await import('@codemirror/lang-javascript')).typescriptLanguage.parser,
  json: async () => (await import('@codemirror/lang-json')).jsonLanguage.parser,
  python: () =>
    streamMode(import('@codemirror/legacy-modes/mode/python').then((mode) => mode.python)),
  go: () => streamMode(import('@codemirror/legacy-modes/mode/go').then((mode) => mode.go)),
  dart: () => streamMode(import('@codemirror/legacy-modes/mode/clike').then((mode) => mode.dart)),
  kotlin: () =>
    streamMode(import('@codemirror/legacy-modes/mode/clike').then((mode) => mode.kotlin)),
  java: () => streamMode(import('@codemirror/legacy-modes/mode/clike').then((mode) => mode.java)),
  swift: () => streamMode(import('@codemirror/legacy-modes/mode/swift').then((mode) => mode.swift)),
  shell: () => streamMode(import('@codemirror/legacy-modes/mode/shell').then((mode) => mode.shell)),
  dotenv: async () => StreamLanguage.define(DOTENV).parser,
}

const loaded = new Map<CodeLanguage, Promise<Parser>>()

/** The parser for `language`, loaded once and shared by every block. */
export function parserFor(language: CodeLanguage): Promise<Parser> {
  let parser = loaded.get(language)
  if (!parser) {
    parser = PARSERS[language]()
    loaded.set(language, parser)
  }
  return parser
}

/**
 * The ink's classes, put on the page once. The editor mounts the same rules
 * when it opens; a block of code can be the first thing to need them.
 */
function mountInk() {
  if (typeof document === 'undefined' || document.querySelector('style[data-code-ink]')) return
  const rules = INK.module?.getRules()
  if (!rules) return
  const style = document.createElement('style')
  style.dataset.codeInk = ''
  style.textContent = rules
  document.head.append(style)
}

/** `code` as runs of text, each token in its ink; plain text in between. */
export function colour(code: string, parser: Parser): ReactNode[] {
  mountInk()
  const runs: ReactNode[] = []
  let at = 0
  highlightTree(parser.parse(code), INK, (from, to, classes) => {
    if (from > at) runs.push(code.slice(at, from))
    runs.push(createElement('span', { key: from, className: classes }, code.slice(from, to)))
    at = to
  })
  if (at < code.length) runs.push(code.slice(at))
  return runs
}
