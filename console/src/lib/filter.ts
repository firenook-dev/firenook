// One filter language for every section's filter field, parsed the same way
// here and in the engine (`crates/console-front/src/filter.rs`), so the URL's
// `q` means the same thing on both sides. GitHub's search grammar, which
// developers already type:
//
//   query   = *WS [ item *( 1*WS item ) ] *WS
//   item    = [ "-" ] ( term / phrase / regex / word )  ; "-" negates
//   term    = key ( ":" / "=" ) [ op ] value
//   key     = ALPHA *( ALPHA / DIGIT / "_" / "." / "-" ) ; case-insensitive, except a Path key's suffix
//   regex   = "/" 1*( any but "/" and "\" / "\" any ) "/" [ "i" ]  ; only in a field set that opts in
//   op      = ">=" / "<=" / ">" / "<"
//   value   = phrase / bare
//   phrase  = DQUOTE *( any but DQUOTE and "\" / "\" ( DQUOTE / "\" ) ) DQUOTE
//   bare    = 1*( any but WS and DQUOTE )
//   word    = bare                                        ; a bare token that is not a term
//   WS      = space, tab, line feed, carriage return, form feed or vertical tab
//
// Every term and word must match; a key repeated with `:` on an enum or exact
// field matches any of its values; two ranges on one key must both hold; every
// negated term excludes on its own. An unknown key is an error, never text:
// `foo:bar` silently searching for "foo:bar" is the failure this prevents, and
// a quoted phrase is how to search for it.
//
// The golden file `filter-cases.json` beside this one pins every case both
// sides must agree on, messages and UTF-16 spans included. Spans are UTF-16
// offsets because that is what a JavaScript string and an input's selection
// count in, so the field can underline exactly what the engine refused.

export type FilterOp = 'eq' | 'gt' | 'ge' | 'lt' | 'le'

/** One `key:value` item. After validation the key is canonical and an enum's value too. */
export interface FilterTerm {
  /** The field's key (lowercase), or a `Path` prefix as declared followed by the suffix as typed. */
  key: string
  op: FilterOp
  /** Unquoted; an enum's canonical value or `true`/`false` for a boolean, as typed otherwise. */
  value: string
  negated: boolean
  /** UTF-16 offsets of the whole item in the text. */
  from: number
  to: number
}

/** A word or quoted phrase, matched against the section's text fields. */
export interface FilterWord {
  text: string
  negated: boolean
  from: number
  to: number
}

/** A `/pattern/` item, passed through for the section to compile. */
export interface FilterRegex {
  /** What stood between the slashes, backslashes kept. */
  pattern: string
  caseInsensitive: boolean
  negated: boolean
  from: number
  to: number
}

export interface FilterQuery {
  terms: FilterTerm[]
  words: FilterWord[]
  regexes: FilterRegex[]
}

/** Why a filter cannot be used, and the UTF-16 span to underline. */
export interface FilterError {
  message: string
  from: number
  to: number
}

export type FilterResult = { ok: true; query: FilterQuery } | { ok: false; error: FilterError }

export type FieldKind =
  | 'text'
  | 'exact'
  | 'enum'
  | 'path'
  | 'bool'
  | 'time'
  | 'number'
  | 'bytes'
  | 'duration'

/**
 * One field a list accepts: the shape the engine serves in `ListMeta.fields`
 * (`FieldSpecInfo`) and the golden file writes, so either can be passed as is.
 */
export interface FieldSpec {
  key: string
  aliases?: readonly string[] | undefined
  kind: FieldKind
  /** One line for the completion list: "Sign-in provider". */
  help?: string | undefined
  /** An enum's values, canonical spellings. */
  values?: readonly string[] | undefined
  /** An enum's short spellings, each with the value it means: `{ google: 'google.com' }`. */
  valueAliases?: Readonly<Record<string, string>> | undefined
  /** A path field's prefixes: `data.`, `labels.`. */
  prefixes?: readonly string[] | undefined
}

/** A list's fields, and whether `/regex/` items are items (Logs) or words (everywhere else). */
export interface FieldSet {
  fields: readonly FieldSpec[]
  regex?: boolean | undefined
}

const REGEX_MESSAGE =
  'A "/" starts a regex in this filter; quote the text to search for a path, like "/api/users".'
const QUOTE_NOT_CLOSED = 'This quote is not closed.'
const SPACE_AFTER_QUOTE = 'Put a space after the closing quote.'
const QUOTE_IN_WORD = 'Put a space before this quote, or quote the whole text.'

const OP_SPELLING: Record<FilterOp, string> = { eq: ':', gt: '>', ge: '>=', lt: '<', le: '<=' }

/** The kinds `<` and `>` mean something for. */
const ORDERED: ReadonlySet<FieldKind> = new Set(['path', 'time', 'number', 'bytes', 'duration'])

function isWs(character: string | undefined): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\f' ||
    character === '\v'
  )
}

function isAsciiAlpha(character: string | undefined): boolean {
  return character !== undefined && /^[A-Za-z]$/.test(character)
}

function isKeyChar(character: string | undefined): boolean {
  return character !== undefined && /^[A-Za-z0-9_.-]$/.test(character)
}

/** ASCII-only lowercasing, as Rust's `to_ascii_lowercase`: `É` stays `É`. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

function asciiEqualIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && asciiLower(a) === asciiLower(b)
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1)
    if (text.charCodeAt(index) > 0x7f) return false
  return true
}

class Parser {
  /** One entry per Unicode scalar, as Rust's `chars()`. */
  private readonly chars: string[]
  /** The UTF-16 offset of each char, and of the end. */
  private readonly utf16: number[]

  private readonly regex: boolean

  constructor(text: string, regex: boolean) {
    this.regex = regex
    this.chars = Array.from(text)
    this.utf16 = []
    let offset = 0
    for (const character of this.chars) {
      this.utf16.push(offset)
      offset += character.length
    }
    this.utf16.push(offset)
  }

  private error(message: string, from: number, to: number): FilterError {
    return { message, from: this.utf16[from] ?? 0, to: this.utf16[to] ?? 0 }
  }

  private offset(at: number): number {
    return this.utf16[at] ?? 0
  }

  /** The end of the run of non-whitespace starting at `at`. */
  private runEnd(at: number): number {
    let end = at
    while (end < this.chars.length && !isWs(this.chars[end])) end += 1
    return end
  }

  parse(): FilterResult {
    const query: FilterQuery = { terms: [], words: [], regexes: [] }
    const length = this.chars.length
    let at = 0
    for (;;) {
      while (at < length && isWs(this.chars[at])) at += 1
      if (at === length) return { ok: true, query }
      const start = at
      let negated = false
      if (this.chars[at] === '-' && at + 1 < length && !isWs(this.chars[at + 1])) {
        negated = true
        at += 1
      }
      const character = this.chars[at]
      if (character === '"') {
        const phrase = this.phrase(at)
        if (!phrase.ok) return phrase
        const boundary = this.boundary(start, phrase.end)
        if (boundary) return { ok: false, error: boundary }
        query.words.push({
          text: phrase.text,
          negated,
          from: this.offset(start),
          to: this.offset(phrase.end),
        })
        at = phrase.end
      } else if (character === '/' && this.regex) {
        const item = this.regexItem(start, at)
        if (!item.ok) return item
        query.regexes.push({
          pattern: item.pattern,
          caseInsensitive: item.caseInsensitive,
          negated,
          from: this.offset(start),
          to: this.offset(item.end),
        })
        at = item.end
      } else {
        const separator = this.keyEnd(at)
        if (separator !== undefined) {
          const term = this.term(start, at, separator, negated)
          if (!term.ok) return term
          query.terms.push(term.term)
          at = term.end
        } else {
          const bare = this.bare(at)
          if (!bare.ok) return bare
          query.words.push({
            text: bare.text,
            negated,
            from: this.offset(start),
            to: this.offset(bare.end),
          })
          at = bare.end
        }
      }
    }
  }

  /** After a quoted phrase: the item must end there. */
  private boundary(start: number, end: number): FilterError | undefined {
    if (end < this.chars.length && !isWs(this.chars[end]))
      return this.error(SPACE_AFTER_QUOTE, start, this.runEnd(end))
    return undefined
  }

  /** A quoted phrase starting at `at`: its text and where it ends. */
  private phrase(
    at: number,
  ): { ok: true; text: string; end: number } | { ok: false; error: FilterError } {
    let text = ''
    let index = at + 1
    while (index < this.chars.length) {
      const character = this.chars[index]
      const next = this.chars[index + 1]
      if (character === '\\' && (next === '"' || next === '\\')) {
        text += next
        index += 2
      } else if (character === '"') {
        return { ok: true, text, end: index + 1 }
      } else {
        text += character
        index += 1
      }
    }
    return { ok: false, error: this.error(QUOTE_NOT_CLOSED, at, this.chars.length) }
  }

  /** A `/pattern/` or `/pattern/i` item whose slash is at `at`. */
  private regexItem(
    start: number,
    at: number,
  ):
    | { ok: true; pattern: string; caseInsensitive: boolean; end: number }
    | { ok: false; error: FilterError } {
    const refused = () => ({
      ok: false as const,
      error: this.error(REGEX_MESSAGE, start, this.runEnd(at)),
    })
    let pattern = ''
    let index = at + 1
    for (;;) {
      const character = this.chars[index]
      if (character === undefined) return refused()
      if (character === '\\' && index + 1 < this.chars.length) {
        pattern += character + (this.chars[index + 1] ?? '')
        index += 2
      } else if (character === '/') {
        break
      } else {
        pattern += character
        index += 1
      }
    }
    if (pattern === '') return refused()
    let end = index + 1
    const caseInsensitive = this.chars[end] === 'i'
    if (caseInsensitive) end += 1
    if (end < this.chars.length && !isWs(this.chars[end])) return refused()
    return { ok: true, pattern, caseInsensitive, end }
  }

  /** Where the `:` or `=` of a term starting at `at` is, when it is one. */
  private keyEnd(at: number): number | undefined {
    if (!isAsciiAlpha(this.chars[at])) return undefined
    let end = at + 1
    while (end < this.chars.length && isKeyChar(this.chars[end])) end += 1
    const separator = this.chars[end]
    return separator === ':' || separator === '=' ? end : undefined
  }

  /** A term whose item starts at `start`, key at `at`, separator at `separator`. */
  private term(
    start: number,
    at: number,
    separator: number,
    negated: boolean,
  ): { ok: true; term: FilterTerm; end: number } | { ok: false; error: FilterError } {
    const key = this.chars.slice(at, separator).join('')
    let index = separator + 1
    const first = this.chars[index]
    const second = this.chars[index + 1]
    let op: FilterOp = 'eq'
    if (first === '>' && second === '=') {
      op = 'ge'
      index += 2
    } else if (first === '<' && second === '=') {
      op = 'le'
      index += 2
    } else if (first === '>') {
      op = 'gt'
      index += 1
    } else if (first === '<') {
      op = 'lt'
      index += 1
    }
    let value: string
    let end: number
    if (this.chars[index] === '"') {
      const phrase = this.phrase(index)
      if (!phrase.ok) return phrase
      const boundary = this.boundary(start, phrase.end)
      if (boundary) return { ok: false, error: boundary }
      value = phrase.text
      end = phrase.end
    } else {
      const bare = this.bare(index)
      if (!bare.ok) return bare
      value = bare.text
      end = bare.end
    }
    return {
      ok: true,
      term: { key, op, value, negated, from: this.offset(start), to: this.offset(end) },
      end,
    }
  }

  /** Bare text from `at` to the next whitespace; a quote inside it is an error. */
  private bare(
    at: number,
  ): { ok: true; text: string; end: number } | { ok: false; error: FilterError } {
    const end = this.runEnd(at)
    for (let index = at; index < end; index += 1)
      if (this.chars[index] === '"')
        return { ok: false, error: this.error(QUOTE_IN_WORD, index, index + 1) }
    return { ok: true, text: this.chars.slice(at, end).join(''), end }
  }
}

/** Parses `text`; `regex` says whether `/…/` is a regex item or a word. */
export function parseFilter(text: string, regex = false): FilterResult {
  return new Parser(text, regex).parse()
}

/**
 * Checks every term against `set`: resolves key aliases and `Path` prefixes,
 * enum values and their aliases, each kind's value syntax, and that `<` and
 * `>` are used only on ordered kinds.
 */
export function validateFilter(query: FilterQuery, set: FieldSet): FilterResult {
  const terms: FilterTerm[] = []
  for (const term of query.terms) {
    const checked = validateTerm(term, set)
    if ('message' in checked) return { ok: false, error: checked }
    terms.push(checked)
  }
  return { ok: true, query: { terms, words: query.words, regexes: query.regexes } }
}

/** Parses and validates `text` against a list's fields. */
export function checkFilter(text: string, set: FieldSet): FilterResult {
  const parsed = parseFilter(text, set.regex ?? false)
  return parsed.ok ? validateFilter(parsed.query, set) : parsed
}

/**
 * A text checked against `set`, in the golden file's shape: `{ ok: query }`
 * or `{ error: { from, to, message } }`. Vitest compares cases files with it.
 */
export function filterOutcome(
  text: string,
  set: FieldSet,
): { ok: FilterQuery } | { error: FilterError } {
  const result = checkFilter(text, set)
  return result.ok
    ? { ok: result.query }
    : { error: { from: result.error.from, to: result.error.to, message: result.error.message } }
}

function validateTerm(term: FilterTerm, set: FieldSet): FilterTerm | FilterError {
  const refuse = (message: string): FilterError => ({ message, from: term.from, to: term.to })
  const typed = `"${term.key}:"`
  const resolved = resolveKey(term.key, asciiLower(term.key), set)
  if ('message' in resolved) return refuse(resolved.message)
  const { key, field } = resolved
  if (term.op !== 'eq' && !ORDERED.has(field.kind))
    return refuse(`"${OP_SPELLING[term.op]}" works on times, numbers, sizes and durations only.`)
  let value = term.value
  switch (field.kind) {
    case 'text':
    case 'exact':
    case 'path':
      if (term.value === '') return refuse(`${typed} needs a value.`)
      break
    case 'enum': {
      const canonical = enumValue(term.value, field)
      if (canonical === undefined) return refuse(`${typed} is one of ${describeEnum(field)}.`)
      value = canonical
      break
    }
    case 'bool': {
      const lower = asciiLower(term.value)
      if (lower === 'true' || lower === 'yes') value = 'true'
      else if (lower === 'false' || lower === 'no') value = 'false'
      else return refuse(`${typed} is true or false.`)
      break
    }
    case 'time':
      if (parseTime(term.value, 0) === undefined)
        return refuse(`${typed} needs a time, like 2026-10-01, -2h or today.`)
      break
    case 'number':
      if (parseNumber(term.value) === undefined)
        return refuse(`${typed} needs a number, like 42 or 2.5.`)
      break
    case 'bytes':
      if (parseBytes(term.value) === undefined)
        return refuse(`${typed} needs a size, like 512, 10KB or 2MB.`)
      break
    case 'duration':
      if (parseDuration(term.value) === undefined)
        return refuse(`${typed} needs a duration, like 250ms, 2s or 1.5m.`)
      break
  }
  return { key, op: term.op, value, negated: term.negated, from: term.from, to: term.to }
}

function keyNames(field: FieldSpec): string[] {
  return [field.key, ...(field.aliases ?? [])]
}

function needsName(prefix: string): string {
  return `"${prefix}" needs a field name after it, like ${prefix}userId:u_1.`
}

/** The canonical key of a term typed as `typed` (`lower` lowercased), with its field. */
function resolveKey(
  typed: string,
  lower: string,
  set: FieldSet,
): { key: string; field: FieldSpec } | { message: string } {
  for (const field of set.fields) {
    if (field.kind !== 'path') continue
    const prefixes = field.prefixes ?? []
    for (const prefix of prefixes) {
      if (lower.startsWith(asciiLower(prefix))) {
        const suffix = typed.slice(prefix.length)
        if (suffix === '') return { message: needsName(prefix) }
        return { key: `${prefix}${suffix}`, field }
      }
    }
    // The help entry's key, an alias, or a prefix without its dot names no field yet.
    const bare = prefixes.find((prefix) => asciiEqualIgnoreCase(prefix.replace(/\.+$/, ''), lower))
    if (bare !== undefined) return { message: needsName(bare) }
    if (keyNames(field).some((name) => asciiEqualIgnoreCase(name, lower)))
      return { message: needsName(prefixes[0] ?? field.key) }
  }
  for (const field of set.fields) {
    if (field.kind === 'path') continue
    if (keyNames(field).some((name) => asciiEqualIgnoreCase(name, lower)))
      return { key: field.key, field }
  }
  return { message: unknownKey(typed, set) }
}

function unknownKey(typed: string, set: FieldSet): string {
  const names = [
    ...set.fields.filter((field) => field.kind !== 'path').map((field) => field.key),
    ...set.fields
      .filter((field) => field.kind === 'path')
      .map((field) => `${field.prefixes?.[0] ?? field.key}…`),
  ]
  if (names.length === 0)
    return `Unknown filter "${typed}:". This list has no filters; quote it to search for the text.`
  return `Unknown filter "${typed}:". Use ${joinOr(names)}; quote it to search for the text.`
}

/** `a`, `a or b`, `a, b or c`. */
function joinOr(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

/**
 * An enum's short spellings in the engine's order: the engine serves them as
 * a sorted map, and the golden harness reads them into one.
 */
function sortedAliases(field: FieldSpec): [string, string][] {
  return Object.entries(field.valueAliases ?? {}).toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
}

/** The canonical value `typed` names, case-insensitively, directly or through an alias. */
function enumValue(typed: string, field: FieldSpec): string | undefined {
  const direct = (field.values ?? []).find((value) => asciiEqualIgnoreCase(value, typed))
  if (direct !== undefined) return direct
  return sortedAliases(field).find(([alias]) => asciiEqualIgnoreCase(alias, typed))?.[1]
}

/** `password, google.com (google), phone, anonymous`. */
function describeEnum(field: FieldSpec): string {
  const aliases = sortedAliases(field)
  return (field.values ?? [])
    .map((value) => {
      const spellings = aliases.filter(([, target]) => target === value).map(([alias]) => alias)
      return spellings.length === 0 ? value : `${value} (${spellings.join(', ')})`
    })
    .join(', ')
}

/** A decimal number: digits, an optional fraction, an optional leading minus. */
export function parseNumber(text: string): number | undefined {
  const digits = text.startsWith('-') ? text.slice(1) : text
  const point = digits.indexOf('.')
  const whole = point === -1 ? digits : digits.slice(0, point)
  const fraction = point === -1 ? '' : digits.slice(point + 1)
  if (
    whole === '' ||
    !/^[0-9]+$/.test(whole) ||
    !/^[0-9]*$/.test(fraction) ||
    (point !== -1 && fraction === '')
  )
    return undefined
  return Number(text)
}

/** A non-negative decimal followed by a unit, the unit split off lowercased. */
function numberAndUnit(text: string): { number: number; unit: string } | undefined {
  const match = /[^0-9.]/.exec(text)
  const split = match ? match.index : text.length
  const number = text.slice(0, split)
  if (number === '') return undefined
  const parsed = parseNumber(number)
  return parsed === undefined ? undefined : { number: parsed, unit: asciiLower(text.slice(split)) }
}

const BYTE_POWERS: Record<string, number> = { '': 0, b: 0, kb: 1, mb: 2, gb: 3, tb: 4 }

/** A size in bytes: `512`, `10KB`, `2MB`, `1.5GB` (any case, powers of 1024). */
export function parseBytes(text: string): number | undefined {
  const parsed = numberAndUnit(text)
  if (!parsed) return undefined
  const power = BYTE_POWERS[parsed.unit]
  if (power === undefined) return undefined
  const bytes = parsed.number * 1024 ** power
  return Number.isFinite(bytes) ? Math.round(bytes) : undefined
}

const DURATION_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 }
/** Rust's `Duration` holds up to 2^64 seconds. */
const MAX_DURATION_SECONDS = 2 ** 64

/** A duration in milliseconds: `250ms`, `2s`, `1.5m`, `1h` (any case). */
export function parseDuration(text: string): number | undefined {
  const parsed = numberAndUnit(text)
  if (!parsed) return undefined
  const scale = DURATION_SECONDS[parsed.unit]
  if (scale === undefined) return undefined
  const seconds = parsed.unit === 'ms' ? parsed.number / 1000 : parsed.number * scale
  if (!Number.isFinite(seconds) || seconds >= MAX_DURATION_SECONDS) return undefined
  return seconds * 1000
}

/** UTC epoch ms of a calendar instant, years 0–99 included (`Date.UTC` maps those to 19xx). */
function utcMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, ms)
  return date.getTime()
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** The engine's time range: years -9999 to 9999. */
const MIN_TIME_MS = utcMs(-9999, 1, 1)
const MAX_I64 = 9_223_372_036_854_775_807n
const UNIT_SECONDS: Record<string, bigint> = { s: 1n, m: 60n, h: 3_600n, d: 86_400n, w: 604_800n }

/** `YYYY-MM-DD`, a real calendar day, as UTC midnight. */
function parseDate(text: string): number | undefined {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined
  return utcMs(year, month, day)
}

const RFC3339 =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[^]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:([Zz])|([+-])([0-9]{2}):([0-9]{2}))$/

/**
 * RFC 3339 as the engine reads it: any one separator (the caller has checked
 * the text is ASCII, so one character is one byte), a leap second only where
 * one can be.
 */
function parseRfc3339(text: string): number | undefined {
  const match = RFC3339.exec(text)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s, fraction, zulu, sign, oh, om] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  let second = Number(s)
  let ms = fraction ? Number(fraction.slice(0, 3).padEnd(3, '0')) : 0
  let offsetMinutes = 0
  if (!zulu) {
    const offsetHour = Number(oh)
    const offsetMinute = Number(om)
    if (offsetHour > 23 || offsetMinute > 59) return undefined
    offsetMinutes = (sign === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute)
  }
  const leap = second === 60
  if (leap) {
    second = 59
    ms = 999
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined
  if (hour > 23 || minute > 59 || second > 59) return undefined
  const instant = utcMs(year, month, day, hour, minute, second, ms) - offsetMinutes * 60_000
  if (leap) {
    // A leap second stands in for the last instant of a month, in UTC.
    const utc = new Date(instant)
    const utcYear = utc.getUTCFullYear()
    const utcMonth = utc.getUTCMonth() + 1
    if (
      utcYear < -9999 ||
      utcYear > 9999 ||
      utc.getUTCHours() !== 23 ||
      utc.getUTCMinutes() !== 59 ||
      utc.getUTCSeconds() !== 59 ||
      utc.getUTCDate() !== daysInMonth(utcYear, utcMonth)
    )
      return undefined
  }
  return instant
}

/**
 * A time relative to `now` (epoch ms), as epoch ms: RFC 3339, `YYYY-MM-DD`
 * (UTC midnight), `now`, `today` (UTC midnight), or `-<n><unit>` with `s`,
 * `m`, `h`, `d` or `w` (any case).
 */
export function parseTime(text: string, now: number = Date.now()): number | undefined {
  const lower = asciiLower(text)
  if (lower === 'now') return now
  if (lower === 'today') return now - (((now % 86_400_000) + 86_400_000) % 86_400_000)
  if (lower.startsWith('-')) {
    const relative = lower.slice(1)
    const unit = Array.from(relative).at(-1)
    const scale = unit === undefined ? undefined : UNIT_SECONDS[unit]
    const amount = relative.slice(0, relative.length - (unit?.length ?? 0))
    if (scale === undefined || amount === '' || !/^[0-9]+$/.test(amount)) return undefined
    const count = BigInt(amount)
    if (count > MAX_I64) return undefined
    const seconds = count * scale
    if (seconds > MAX_I64) return undefined
    const instant = BigInt(Math.floor(now)) - seconds * 1000n
    return instant < BigInt(MIN_TIME_MS) ? undefined : Number(instant)
  }
  // A character outside ASCII never makes a date: the engine reads these by byte.
  if (!isAscii(text)) return undefined
  if (text.length === 10) return parseDate(text)
  return parseRfc3339(text)
}
