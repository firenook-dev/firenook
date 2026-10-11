// The Firestore rules language for the code editor: highlighting from
// ./scan, indentation by brackets, folding of brace blocks, comment and
// bracket data, and completion from ./complete as the language's
// `autocomplete` data, so the editor's own `autocompletion()` finds it.
//
// Each token's kind is its highlighting tag (`TAGS` below). Several are a
// modified form of a common tag — a path literal is `special(string)`, a
// method call `function(propertyName)` — so a theme that styles only the
// common tag still colours them, and one that wants to tell them apart can.

import { LanguageSupport, StreamLanguage, foldService } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { type Tag, tags as t } from '@lezer/highlight'
import { rulesCompletionSource } from './complete'
import type { RulesLanguageOptions } from './options'
import { isBrace, outlineOf } from './outline'
import { type ScanState, type Style, indentation, initialState, scanToken } from './scan'

/** The highlighting tag of each kind of token. */
export const TAGS: Readonly<Record<Style, Tag>> = {
  keyword: t.keyword,
  controlKeyword: t.controlKeyword,
  definitionKeyword: t.definitionKeyword,
  operatorKeyword: t.operatorKeyword,
  operation: t.special(t.keyword),
  bool: t.bool,
  null: t.null,
  number: t.number,
  string: t.string,
  escape: t.escape,
  lineComment: t.lineComment,
  blockComment: t.blockComment,
  variableName: t.variableName,
  builtin: t.standard(t.variableName),
  definition: t.definition(t.variableName),
  functionDef: t.function(t.definition(t.variableName)),
  call: t.function(t.variableName),
  builtinCall: t.function(t.standard(t.variableName)),
  property: t.propertyName,
  method: t.function(t.propertyName),
  namespace: t.namespace,
  typeName: t.typeName,
  path: t.special(t.string),
  wildcard: t.special(t.variableName),
  interpolation: t.special(t.brace),
  logicOperator: t.logicOperator,
  compareOperator: t.compareOperator,
  arithmeticOperator: t.arithmeticOperator,
  operator: t.operator,
  definitionOperator: t.definitionOperator,
  derefOperator: t.derefOperator,
  separator: t.separator,
  punctuation: t.punctuation,
  brace: t.brace,
  paren: t.paren,
  squareBracket: t.squareBracket,
  invalid: t.invalid,
}

export const rulesStreamLanguage = StreamLanguage.define<ScanState>({
  name: 'firestore-rules',
  startState: () => initialState(),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    const { end, style } = scanToken(stream.string, stream.pos, state)
    stream.pos = end
    return style
  },
  indent: (state, textAfter, context) => indentation(state, textAfter, context.unit),
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"'] },
    indentOnInput: /^\s*[}\])]$/,
  },
  tokenTable: TAGS,
})

/**
 * Folds a brace block from the line its `{` is on: the first one on the
 * line that closes on a later line, which is the outermost.
 */
export const braceFolding = foldService.of((state, lineStart, lineEnd) => {
  const { brackets } = outlineOf(state.doc)
  let lo = 0
  let hi = brackets.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (brackets[mid]!.open < lineStart) lo = mid + 1
    else hi = mid
  }
  for (let i = lo; i < brackets.length; i++) {
    const bracket = brackets[i]!
    if (bracket.open >= lineEnd) break
    if (isBrace(bracket) && bracket.end !== null && bracket.end > lineEnd)
      return { from: bracket.start, to: bracket.end }
  }
  return null
})

/**
 * Everything the editor needs for rules: the language (highlighting,
 * indentation, brace folding, comment tokens `//` and block), bracket
 * matching data, and completion registered as language data so the
 * editor's existing `autocompletion()` picks it up.
 */
export function rulesLanguage(options: RulesLanguageOptions = {}): Extension {
  return new LanguageSupport(rulesStreamLanguage, [
    rulesStreamLanguage.data.of({ autocomplete: rulesCompletionSource(options) }),
    braceFolding,
  ])
}
