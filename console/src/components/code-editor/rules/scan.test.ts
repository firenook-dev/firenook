import { describe, expect, it } from 'vitest'
import { RULES } from './fixture'
import { indentation, initialState, lex } from './scan'

/** The kind of the token where the nth `needle` starts. */
function kindOf(text: string, needle: string, nth = 0): string | undefined {
  let at = -1
  for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1)
  if (at < 0) throw new Error(`no ${needle}`)
  return lex(text).find((t) => t.from <= at && at < t.to)?.style
}

function kinds(text: string): [string, string][] {
  return lex(text).map((t) => [t.text, t.style])
}

describe('tokens of a ruleset', () => {
  it('reads the statement keywords', () => {
    expect(kindOf(RULES, 'rules_version')).toBe('keyword')
    expect(kindOf(RULES, 'service')).toBe('keyword')
    expect(kindOf(RULES, 'match')).toBe('keyword')
    expect(kindOf(RULES, 'allow')).toBe('keyword')
    expect(kindOf(RULES, 'function')).toBe('definitionKeyword')
    expect(kindOf(RULES, 'let')).toBe('definitionKeyword')
    expect(kindOf(RULES, 'return')).toBe('controlKeyword')
    expect(kindOf(RULES, 'if isOwner')).toBe('controlKeyword')
    expect(kindOf(RULES, 'is string')).toBe('operatorKeyword')
  })

  it('reads the service name as a namespace', () => {
    expect(kinds('service cloud.firestore {')).toEqual([
      ['service', 'keyword'],
      ['cloud', 'namespace'],
      ['.', 'derefOperator'],
      ['firestore', 'namespace'],
      ['{', 'brace'],
    ])
  })

  it('reads operation names after allow, and only there', () => {
    expect(kinds('allow read, write: if true;').slice(0, 5)).toEqual([
      ['allow', 'keyword'],
      ['read', 'operation'],
      [',', 'separator'],
      ['write', 'operation'],
      [':', 'punctuation'],
    ])
    expect(kindOf(RULES, 'get:')).toBe('operation')
    // The same word after the colon is the function.
    expect(kindOf(RULES, 'get(/databases')).toBe('builtinCall')
    expect(kindOf('allow read: if read;', 'read', 1)).toBe('variableName')
  })

  it('reads a match path, its wildcards distinctly', () => {
    expect(kinds('match /databases/{database}/documents {')).toEqual([
      ['match', 'keyword'],
      ['/databases/', 'path'],
      ['{database}', 'wildcard'],
      ['/documents', 'path'],
      ['{', 'brace'],
    ])
    expect(kinds('match /users/{uid}/{document=**} {').slice(1, 5)).toEqual([
      ['/users/', 'path'],
      ['{uid}', 'wildcard'],
      ['/', 'path'],
      ['{document=**}', 'wildcard'],
    ])
  })

  it('reads a path in an expression, with its interpolations', () => {
    expect(kinds('exists(/databases/$(database)/documents/users/$(request.auth.uid))')).toEqual([
      ['exists', 'builtinCall'],
      ['(', 'paren'],
      ['/databases/', 'path'],
      ['$(', 'interpolation'],
      ['database', 'variableName'],
      [')', 'interpolation'],
      ['/documents/users/', 'path'],
      ['$(', 'interpolation'],
      ['request', 'builtin'],
      ['.', 'derefOperator'],
      ['auth', 'property'],
      ['.', 'derefOperator'],
      ['uid', 'property'],
      [')', 'interpolation'],
      [')', 'paren'],
    ])
  })

  it('reads the default database by name inside a path', () => {
    expect(kinds('get(/databases/(default)/documents/a/b)').slice(2, 4)).toEqual([
      ['/databases/(default)/documents/a/b', 'path'],
      [')', 'paren'],
    ])
  })

  it('tells a division from a path by what comes before the slash', () => {
    expect(kinds('a / 2')).toEqual([
      ['a', 'variableName'],
      ['/', 'arithmeticOperator'],
      ['2', 'number'],
    ])
    expect(kinds('f(x) / 2')[4]).toEqual(['/', 'arithmeticOperator'])
    expect(kinds('x == /a/b')[2]).toEqual(['/a/b', 'path'])
  })

  it('reads members after a dot, and calls by their parenthesis', () => {
    expect(kinds('resource.data.keys().hasAll(x)')).toEqual([
      ['resource', 'builtin'],
      ['.', 'derefOperator'],
      ['data', 'property'],
      ['.', 'derefOperator'],
      ['keys', 'method'],
      ['(', 'paren'],
      [')', 'paren'],
      ['.', 'derefOperator'],
      ['hasAll', 'method'],
      ['(', 'paren'],
      ['x', 'variableName'],
      [')', 'paren'],
    ])
    expect(kindOf(RULES, 'isOwner()')).toBe('functionDef')
    expect(kindOf(RULES, 'isOwner()', 1)).toBe('call')
    expect(kindOf(RULES, 'duration.value')).toBe('namespace')
    expect(kindOf(RULES, 'value(1')).toBe('method')
  })

  it('reads function parameters and lets as definitions', () => {
    expect(kinds('function f(a, b) { let c = a; return c; }').slice(0, 7)).toEqual([
      ['function', 'definitionKeyword'],
      ['f', 'functionDef'],
      ['(', 'paren'],
      ['a', 'definition'],
      [',', 'separator'],
      ['b', 'definition'],
      [')', 'paren'],
    ])
    expect(kindOf(RULES, 'profile =')).toBe('definition')
    expect(kindOf(RULES, 'profile.data')).toBe('variableName')
  })

  it('reads literals', () => {
    expect(kindOf(RULES, "'2'")).toBe('string')
    expect(kindOf(RULES, '1000.50')).toBe('number')
    expect(kindOf(RULES, 'null;')).toBe('null')
    expect(kinds('true false 0x1F 1e3')).toEqual([
      ['true', 'bool'],
      ['false', 'bool'],
      ['0x1F', 'number'],
      ['1e3', 'number'],
    ])
    expect(kinds('x < .5')[2]).toEqual(['.5', 'number'])
    expect(kinds("b'\\x2A'")).toEqual([
      ["b'", 'string'],
      ['\\x2A', 'escape'],
      ["'", 'string'],
    ])
  })

  it('reads escapes inside strings of either quote', () => {
    expect(kinds(`'tag\\'s\\n' != "x\\"y"`)).toEqual([
      ["'tag", 'string'],
      ["\\'", 'escape'],
      ['s', 'string'],
      ['\\n', 'escape'],
      ["'", 'string'],
      ['!=', 'compareOperator'],
      ['"x', 'string'],
      ['\\"', 'escape'],
      ['y"', 'string'],
    ])
  })

  it('reads both kinds of comment, a block comment across lines', () => {
    expect(kindOf(RULES, '/* Orders')).toBe('blockComment')
    expect(kindOf(RULES, 'admins can')).toBe('blockComment')
    expect(kindOf(RULES, '// Public')).toBe('lineComment')
    expect(kinds('a // b / c')).toEqual([
      ['a', 'variableName'],
      ['// b / c', 'lineComment'],
    ])
    expect(kinds('/* a */ b')).toEqual([
      ['/* a */', 'blockComment'],
      ['b', 'variableName'],
    ])
  })

  it('reads every operator', () => {
    const ops = lex('a == b != c < d <= e > f >= g && h || !i + j - k * l % m ? n : o')
      .filter((t) => t.text.length && !/^\w/.test(t.text))
      .map((t) => [t.text, t.style])
    expect(ops).toEqual([
      ['==', 'compareOperator'],
      ['!=', 'compareOperator'],
      ['<', 'compareOperator'],
      ['<=', 'compareOperator'],
      ['>', 'compareOperator'],
      ['>=', 'compareOperator'],
      ['&&', 'logicOperator'],
      ['||', 'logicOperator'],
      ['!', 'logicOperator'],
      ['+', 'arithmeticOperator'],
      ['-', 'arithmeticOperator'],
      ['*', 'arithmeticOperator'],
      ['%', 'arithmeticOperator'],
      ['?', 'operator'],
      [':', 'operator'],
    ])
  })

  it('reads a colon in a map literal as punctuation, and its braces as a map', () => {
    const tokens = lex("allow read: if x in {'a': 1};")
    expect(tokens.find((t) => t.text === ':' && t.from > 12)?.style).toBe('punctuation')
    expect(tokens.find((t) => t.text === '{')?.after.stack).toBe('m')
  })

  it('reads types after is', () => {
    expect(kinds('x is timestamp')[2]).toEqual(['timestamp', 'typeName'])
  })

  it('marks what it cannot read rather than stopping', () => {
    expect(kinds('a # b & c')).toEqual([
      ['a', 'variableName'],
      ['#', 'invalid'],
      ['b', 'variableName'],
      ['&', 'invalid'],
      ['c', 'variableName'],
    ])
  })

  it('covers the ruleset without gaps or overlaps, in order', () => {
    const tokens = lex(RULES)
    for (let i = 1; i < tokens.length; i++)
      expect(tokens[i]!.from).toBeGreaterThanOrEqual(tokens[i - 1]!.to)
    // What is not a token is whitespace.
    let rest = RULES
    for (const t of tokens.toReversed()) rest = rest.slice(0, t.from) + rest.slice(t.to)
    expect(rest.trim()).toBe('')
  })
})

describe('half-typed text', () => {
  it('ends an unclosed string at the line', () => {
    const tokens = lex("x == 'abc\ny")
    expect(tokens.map((t) => [t.text, t.style])).toEqual([
      ['x', 'variableName'],
      ['==', 'compareOperator'],
      ["'abc", 'string'],
      ['y', 'variableName'],
    ])
  })

  it('keeps an unclosed block comment open to the end', () => {
    const tokens = lex('a /* b\nc')
    expect(tokens.at(-1)).toMatchObject({ text: 'c', style: 'blockComment' })
    expect(tokens.at(-1)!.after.comment).toBe(true)
  })

  it('reads a wildcard that has not closed', () => {
    expect(kinds('match /users/{ui')).toEqual([
      ['match', 'keyword'],
      ['/users/', 'path'],
      ['{ui', 'wildcard'],
    ])
  })
})

/** The indentation for a line after `text` that begins with `next`. */
function indentAfter(text: string, next = ''): number | null {
  const state = initialState()
  for (const t of lex(text)) Object.assign(state, t.after)
  return indentation(state, next, 2)
}

describe('indentation', () => {
  it('indents one unit per open block', () => {
    expect(indentAfter('service cloud.firestore {\n')).toBe(2)
    expect(indentAfter('service cloud.firestore {\n  match /a/{b} {\n')).toBe(4)
  })

  it('takes a unit back for a line that closes a block', () => {
    expect(indentAfter('service cloud.firestore {\n  match /a/{b} {\n', '}')).toBe(2)
    expect(indentAfter('f({\n', '})')).toBe(0)
  })

  it('indents the second line of an unfinished statement', () => {
    expect(indentAfter('match /a/{b} {\n  allow read: if x\n')).toBe(4)
    expect(indentAfter('match /a/{b} {\n  allow read: if x;\n')).toBe(2)
  })

  it('has no opinion inside a block comment', () => {
    expect(indentAfter('/* a\n')).toBeNull()
  })
})
