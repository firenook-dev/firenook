// The security rules tokenizer, one token at a time (Firestore's and
// Storage's rules are one language).
//
// Two readers drive it: the editor's `StreamLanguage`, which paints the
// text line by line as CodeMirror asks, and `lex`, which reads a whole
// ruleset for the outline (match paths, wildcards, functions) and for
// completion. Sharing one scanner is what keeps the two in agreement: a
// slash the highlighter painted as the start of a path is a path to the
// outline as well, rather than a division the second reader guessed at.
//
// The scanner never fails and always moves forward. Half-typed text is the
// normal case in an editor — an unclosed string, a path that stops at `{`,
// a block with no `}` yet — and each of those is read as far as it goes.

/** The kind of a token, which is also its highlighting tag (see ./language). */
export type Style =
  | 'keyword'
  | 'controlKeyword'
  | 'definitionKeyword'
  | 'operatorKeyword'
  | 'operation'
  | 'bool'
  | 'null'
  | 'number'
  | 'string'
  | 'escape'
  | 'lineComment'
  | 'blockComment'
  | 'variableName'
  | 'builtin'
  | 'definition'
  | 'functionDef'
  | 'call'
  | 'builtinCall'
  | 'property'
  | 'method'
  | 'namespace'
  | 'typeName'
  | 'path'
  | 'wildcard'
  | 'interpolation'
  | 'logicOperator'
  | 'compareOperator'
  | 'arithmeticOperator'
  | 'operator'
  | 'definitionOperator'
  | 'derefOperator'
  | 'separator'
  | 'punctuation'
  | 'brace'
  | 'paren'
  | 'squareBracket'
  | 'invalid'

/**
 * What the last meaningful token was. A slash after an operand divides;
 * anywhere else it starts a path, which is the whole of how the language
 * tells `a / b` from `/databases/...`.
 */
export type Prev = 'start' | 'operand' | 'operator' | 'dot' | 'is' | 'function'

export interface ScanState {
  /** Inside a block comment that has not closed yet. */
  comment: boolean
  /** The quote of the string being read, or '' outside one. Strings end at the line. */
  quote: string
  /**
   * The open brackets, innermost last: `{` a block, `m` a map literal,
   * `(` a parenthesis, `[` a list or index, `$` a path interpolation.
   */
  stack: string
  prev: Prev
  /**
   * A path is being read: 1 after a trailing slash (a wildcard or `$(`
   * may follow), 2 after a wildcard or an interpolation (only a slash
   * continues it), 0 otherwise.
   */
  path: 0 | 1 | 2
  /** A header waiting for the `{` that opens its block. */
  header: '' | 'service' | 'match' | 'function'
  /** Between `allow` and its `:`, where operation names are read. */
  allow: boolean
  /** Inside a function's parameter list. */
  params: boolean
  /** After `let`, before the name it binds. */
  binding: boolean
  /** The bracket depth an unfinished statement began at, or -1. */
  statement: number
}

export function initialState(): ScanState {
  return {
    comment: false,
    quote: '',
    stack: '',
    prev: 'start',
    path: 0,
    header: '',
    allow: false,
    params: false,
    binding: false,
    statement: -1,
  }
}

export interface Step {
  /** Where the token ends; always past where it began. */
  end: number
  /** Its kind, or null for whitespace. */
  style: Style | null
}

const KEYWORDS = new Map<string, Style>([
  ['rules_version', 'keyword'],
  ['service', 'keyword'],
  ['match', 'keyword'],
  ['allow', 'keyword'],
  ['if', 'controlKeyword'],
  ['return', 'controlKeyword'],
  ['function', 'definitionKeyword'],
  ['let', 'definitionKeyword'],
  ['in', 'operatorKeyword'],
  ['is', 'operatorKeyword'],
])

/** The operation names an `allow` grants. */
export const OPERATIONS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'get',
  'list',
  'create',
  'update',
  'delete',
])

/** Functions available everywhere in a Firestore ruleset, without a prefix. */
export const GLOBAL_FUNCTIONS: ReadonlySet<string> = new Set([
  'get',
  'exists',
  'getAfter',
  'existsAfter',
  'debug',
  'int',
  'float',
  'string',
  'bool',
  'path',
])

/**
 * The namespaces whose functions are called with a prefix, as `math.abs(x)`;
 * `firestore` is Storage's (`firestore.get(…)`), painted the same in either.
 */
export const NAMESPACES: ReadonlySet<string> = new Set([
  'math',
  'timestamp',
  'duration',
  'latlng',
  'hashing',
  'firestore',
])

const SPACE = /\s/
const WORD = /\w/
const WORD_START = /[A-Za-z_]/
const DIGIT = /[0-9]/
/** What a path segment may be made of between its slashes. */
const SEGMENT = /[\w\-.~%@+]/
const NUMBER = /0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y
const ESCAPE = /\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{3}|[\s\S])?/y

function step(end: number, style: Style | null): Step {
  return { end, style }
}

function last(stack: string): string {
  return stack.charAt(stack.length - 1)
}

/**
 * Closes the innermost bracket that `closers` names, and with it anything
 * left open inside it. A closer with nothing to close changes nothing.
 */
function popTo(s: ScanState, closers: string): string {
  for (let i = s.stack.length - 1; i >= 0; i--) {
    const open = s.stack.charAt(i)
    if (closers.includes(open)) {
      s.stack = s.stack.slice(0, i)
      if (s.statement > s.stack.length) s.statement = -1
      return open
    }
  }
  return ''
}

/** Whether the next character after spaces is `ch`. */
function followedBy(line: string, from: number, ch: string): boolean {
  let i = from
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  return line[i] === ch
}

function commentAhead(line: string, pos: number): boolean {
  const next = line[pos + 1]
  return next === '/' || next === '*'
}

/**
 * Reads one token of `line` starting at `pos`, updating `state`. The line
 * is the whole line, without its newline; `pos` 0 is its start.
 */
export function scanToken(line: string, pos: number, s: ScanState): Step {
  // Neither a string nor a path carries over a line break.
  if (pos === 0) {
    s.quote = ''
    s.path = 0
  }
  if (s.comment) return blockComment(line, pos, s)
  if (s.quote) return stringBody(line, pos, s)

  const c = line.charAt(pos)
  if (SPACE.test(c)) {
    let i = pos + 1
    while (i < line.length && SPACE.test(line.charAt(i))) i++
    s.path = 0
    return step(i, null)
  }

  if (s.path === 1) {
    if (c === '{') return wildcard(line, pos, s)
    if (c === '$' && line[pos + 1] === '(') {
      s.stack += '$'
      s.path = 0
      s.prev = 'operator'
      return step(pos + 2, 'interpolation')
    }
    s.path = 0
  } else if (s.path === 2) {
    if (c === '/' && !commentAhead(line, pos)) return pathToken(line, pos, s)
    s.path = 0
  }

  if (c === '/') {
    const next = line[pos + 1]
    if (next === '/') return step(line.length, 'lineComment')
    if (next === '*') {
      s.comment = true
      return blockComment(line, pos, s, pos + 2)
    }
    if (s.prev === 'operand') {
      s.prev = 'operator'
      return step(pos + 1, 'arithmeticOperator')
    }
    return pathToken(line, pos, s)
  }

  if (c === "'" || c === '"') return stringStart(line, pos, pos, s)
  if (c === 'b' && (line[pos + 1] === "'" || line[pos + 1] === '"'))
    return stringStart(line, pos, pos + 1, s)

  if (DIGIT.test(c) || (c === '.' && DIGIT.test(line.charAt(pos + 1)) && s.prev !== 'operand')) {
    NUMBER.lastIndex = pos
    const found = NUMBER.exec(line)
    s.prev = 'operand'
    return step(found ? pos + found[0].length : pos + 1, 'number')
  }

  if (WORD_START.test(c)) return identifier(line, pos, s)

  return punctuation(line, pos, c, s)
}

function blockComment(line: string, pos: number, s: ScanState, searchFrom = pos): Step {
  const close = line.indexOf('*/', searchFrom)
  if (close < 0) return step(line.length, 'blockComment')
  s.comment = false
  return step(close + 2, 'blockComment')
}

/** A string from its opening quote at `quoteAt` (after a `b` for bytes). */
function stringStart(line: string, pos: number, quoteAt: number, s: ScanState): Step {
  s.quote = line.charAt(quoteAt)
  s.prev = 'operand'
  return stringRun(line, pos, quoteAt + 1, s)
}

function stringBody(line: string, pos: number, s: ScanState): Step {
  if (line[pos] === '\\') {
    ESCAPE.lastIndex = pos
    const found = ESCAPE.exec(line)
    return step(pos + (found ? found[0].length : 1), 'escape')
  }
  return stringRun(line, pos, pos, s)
}

/** The plain characters of a string up to an escape, its closing quote or the line's end. */
function stringRun(line: string, pos: number, from: number, s: ScanState): Step {
  let i = from
  while (i < line.length && line[i] !== '\\' && line[i] !== s.quote) i++
  if (line[i] === s.quote) {
    s.quote = ''
    i++
  }
  return step(Math.max(i, pos + 1), 'string')
}

/**
 * Slashes and segments up to a wildcard, an interpolation or the end of
 * the path. `(default)`, the name of the default database, is a segment
 * of its own, so `/databases/(default)/documents` is read as one path.
 */
function pathToken(line: string, pos: number, s: ScanState): Step {
  let i = pos + 1
  while (i < line.length) {
    const ch = line.charAt(i)
    if (line[i - 1] === '/' && line.startsWith('(default)', i)) {
      i += '(default)'.length
      continue
    }
    if (SEGMENT.test(ch)) {
      i++
      continue
    }
    if (ch === '/' && line[i - 1] !== '/' && !commentAhead(line, i)) {
      i++
      continue
    }
    break
  }
  s.path = line[i - 1] === '/' ? 1 : 0
  s.prev = 'operand'
  return step(i, 'path')
}

/** `{name}` or `{name=**}`, read as one token so its braces are not the block's. */
function wildcard(line: string, pos: number, s: ScanState): Step {
  let i = pos + 1
  while (i < line.length && WORD.test(line.charAt(i))) i++
  if (line.startsWith('=**', i)) i += 3
  if (line[i] === '}') {
    i++
    s.path = 2
  } else {
    s.path = 0
  }
  s.prev = 'operand'
  return step(i, 'wildcard')
}

function identifier(line: string, pos: number, s: ScanState): Step {
  let end = pos + 1
  while (end < line.length && WORD.test(line.charAt(end))) end++
  const word = line.slice(pos, end)
  const prev = s.prev
  s.prev = 'operand'

  if (s.params) return step(end, 'definition')
  if (prev === 'function') return step(end, 'functionDef')
  if (s.binding) {
    s.binding = false
    return step(end, 'definition')
  }
  // `service cloud.firestore`: the product's name, dots and all.
  if (s.header === 'service') return step(end, 'namespace')
  if (prev === 'dot') return step(end, followedBy(line, end, '(') ? 'method' : 'property')
  if (s.allow && OPERATIONS.has(word)) return step(end, 'operation')

  const keyword = KEYWORDS.get(word)
  if (keyword) {
    applyKeyword(word, s)
    return step(end, keyword)
  }
  if (prev === 'is') return step(end, 'typeName')
  if (word === 'true' || word === 'false') return step(end, 'bool')
  if (word === 'null') return step(end, 'null')
  if (followedBy(line, end, '('))
    return step(end, GLOBAL_FUNCTIONS.has(word) ? 'builtinCall' : 'call')
  if (NAMESPACES.has(word) && followedBy(line, end, '.')) return step(end, 'namespace')
  if (word === 'request' || word === 'resource') return step(end, 'builtin')
  return step(end, 'variableName')
}

function applyKeyword(word: string, s: ScanState): void {
  s.prev = 'operator'
  switch (word) {
    case 'rules_version':
    case 'return':
      s.statement = s.stack.length
      break
    case 'service':
    case 'match':
      s.header = word
      s.allow = false
      s.statement = -1
      break
    case 'allow':
      s.allow = true
      s.statement = s.stack.length
      break
    case 'function':
      s.header = 'function'
      s.prev = 'function'
      s.statement = -1
      break
    case 'let':
      s.binding = true
      s.statement = s.stack.length
      break
    case 'if':
      s.allow = false
      break
    case 'is':
      s.prev = 'is'
      break
  }
}

function punctuation(line: string, pos: number, c: string, s: ScanState): Step {
  const next = line[pos + 1]
  switch (c) {
    case '{': {
      // A block when a header is waiting for it, or when it stands where a
      // statement would; a map literal anywhere inside an expression.
      const block =
        s.header !== '' || (s.prev === 'start' && (s.stack === '' || last(s.stack) === '{'))
      s.stack += block ? '{' : 'm'
      s.header = ''
      s.params = false
      s.binding = false
      if (block) {
        s.prev = 'start'
        s.allow = false
        s.statement = -1
      } else {
        s.prev = 'operator'
      }
      return step(pos + 1, 'brace')
    }
    case '}': {
      const closed = popTo(s, '{m')
      s.prev = closed === 'm' ? 'operand' : 'start'
      if (closed !== 'm') {
        s.allow = false
        s.header = ''
      }
      return step(pos + 1, 'brace')
    }
    case '(':
      s.stack += '('
      if (s.header === 'function') s.params = true
      s.prev = 'operator'
      return step(pos + 1, 'paren')
    case ')': {
      const closed = popTo(s, '($')
      s.prev = 'operand'
      if (closed === '$') {
        s.path = 2
        return step(pos + 1, 'interpolation')
      }
      s.params = false
      return step(pos + 1, 'paren')
    }
    case '[':
      s.stack += '['
      s.prev = 'operator'
      return step(pos + 1, 'squareBracket')
    case ']':
      popTo(s, '[')
      s.prev = 'operand'
      return step(pos + 1, 'squareBracket')
    case ',':
      s.prev = 'operator'
      return step(pos + 1, 'separator')
    case ';':
      s.prev = 'start'
      s.allow = false
      s.header = ''
      s.params = false
      s.binding = false
      if (s.statement >= s.stack.length) s.statement = -1
      return step(pos + 1, 'separator')
    case '.':
      s.prev = 'dot'
      return step(pos + 1, 'derefOperator')
    case ':': {
      s.prev = 'operator'
      if (s.allow) {
        s.allow = false
        return step(pos + 1, 'punctuation')
      }
      const top = last(s.stack)
      return step(pos + 1, top === 'm' || top === '[' ? 'punctuation' : 'operator')
    }
    case '?':
      s.prev = 'operator'
      return step(pos + 1, 'operator')
    case '=':
      s.prev = 'operator'
      return next === '=' ? step(pos + 2, 'compareOperator') : step(pos + 1, 'definitionOperator')
    case '!':
      s.prev = 'operator'
      return next === '=' ? step(pos + 2, 'compareOperator') : step(pos + 1, 'logicOperator')
    case '<':
    case '>':
      s.prev = 'operator'
      return step(next === '=' ? pos + 2 : pos + 1, 'compareOperator')
    case '&':
    case '|':
      if (next === c) {
        s.prev = 'operator'
        return step(pos + 2, 'logicOperator')
      }
      return step(pos + 1, 'invalid')
    case '+':
    case '-':
    case '*':
    case '%':
      s.prev = 'operator'
      return step(pos + 1, 'arithmeticOperator')
    default:
      return step(pos + 1, 'invalid')
  }
}

export interface Token {
  from: number
  to: number
  style: Style
  text: string
  /** The scanner's state just after this token, which says what may follow it. */
  after: ScanState
}

/** Every token of a ruleset, comments included, whitespace left out. */
export function lex(text: string): Token[] {
  const state = initialState()
  const tokens: Token[] = []
  let lineStart = 0
  for (;;) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd < 0) lineEnd = text.length
    const line = text.slice(lineStart, lineEnd)
    let pos = 0
    while (pos < line.length) {
      const { end, style } = scanToken(line, pos, state)
      if (style)
        tokens.push({
          from: lineStart + pos,
          to: lineStart + end,
          style,
          text: line.slice(pos, end),
          after: { ...state },
        })
      pos = end
    }
    if (lineEnd >= text.length) break
    lineStart = lineEnd + 1
  }
  return tokens
}

/**
 * The indentation for a line that begins in `state` and reads
 * `textAfter` (the line without its leading whitespace): one unit per
 * open bracket, one fewer for each bracket the line starts by closing,
 * and one more for the second line of an unfinished statement, such as
 * an `allow` whose condition runs on.
 */
export function indentation(state: ScanState, textAfter: string, unit: number): number | null {
  if (state.comment) return null
  const closing = /^[}\])]+/.exec(textAfter)?.[0].length ?? 0
  let level = state.stack.length - Math.min(closing, state.stack.length)
  if (closing === 0 && state.statement >= 0 && state.statement === state.stack.length) level += 1
  return level * unit
}
