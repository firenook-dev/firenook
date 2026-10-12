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
// The golden file `filter-cases.json` pins every case both sides must agree
// on, messages and UTF-16 spans included; a grammar change edits it first,
// and `filter-golden.ts` runs it here as `filter::golden::run` does there.
// This file is the Rust module written again, line for line where it can
// be: the parser walks Unicode scalar values (Rust's `char`), reports UTF-16
// offsets, and copies its byte-level quirks (a ten-byte time is a date or
// nothing; an RFC 3339 separator is any one byte), because a filter the
// browser accepts and the engine refuses is the bug this exists to prevent.

export type FilterKind =
  | 'text'
  | 'exact'
  | 'enum'
  | 'path'
  | 'bool'
  | 'time'
  | 'number'
  | 'bytes'
  | 'duration'

export type FilterOp = 'eq' | 'gt' | 'ge' | 'lt' | 'le'

/**
 * One field a filter accepts — the engine's `FieldSpecInfo` (which a list
 * serves in `ListMeta.fields`) is one of these as it stands.
 */
export interface FilterFieldDef {
  /** The key as written in a filter: `provider`. For a path field, its help entry. */
  key: string
  /** Other spellings of the key: `p`. */
  aliases?: readonly string[] | undefined
  kind: FilterKind
  /** One line for the completion list: "Sign-in provider". */
  help?: string | undefined
  /** An enum's values, canonical spellings. */
  values?: readonly string[] | undefined
  /** An enum's short spellings, each with the value it means. */
  valueAliases?: Readonly<Record<string, string>> | undefined
  /** A path field's prefixes: `data.`, `labels.`. */
  prefixes?: readonly string[] | undefined
}

/** A list's fields, and whether `/regex/` items are items (Logs) or words. */
export interface FilterFieldSet {
  fields: readonly FilterFieldDef[]
  regex?: boolean | undefined
}

/** One `key:value` item. */
export interface FilterTerm {
  /** As typed until validated; then the field's key, or a path prefix as declared and the suffix as typed. */
  key: string
  op: FilterOp
  /** Unquoted; once validated an enum's canonical value or `true`/`false` for a boolean. */
  value: string
  negated: boolean
  /** UTF-16 offsets of the whole item in the text. */
  from: number
  to: number
}

/** A word or quoted phrase, matched against the list's text fields. */
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

const REGEX_MESSAGE =
  'A "/" starts a regex in this filter; quote the text to search for a path, like "/api/users".'
const QUOTE_NOT_CLOSED = 'This quote is not closed.'
const SPACE_AFTER_QUOTE = 'Put a space after the closing quote.'
const QUOTE_IN_WORD = 'Put a space before this quote, or quote the whole text.'

/** Thrown inside the parser and caught at its door: the first problem ends the parse. */
class Refusal {
  readonly error: FilterError
  constructor(error: FilterError) {
    this.error = error
  }
}

/** The six whitespace characters the grammar separates items with — no others. */
export function isFilterSpace(character: string | undefined): boolean {
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
  if (character === undefined || character.length !== 1) return false
  const code = character.charCodeAt(0)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isAsciiDigit(character: string | undefined): boolean {
  if (character === undefined || character.length !== 1) return false
  const code = character.charCodeAt(0)
  return code >= 48 && code <= 57
}

function isKeyChar(character: string | undefined): boolean {
  return (
    isAsciiAlpha(character) ||
    isAsciiDigit(character) ||
    character === '_' ||
    character === '.' ||
    character === '-'
  )
}

/** Rust's `to_ascii_lowercase`: only A–Z change. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

function sameIgnoringAsciiCase(a: string, b: string): boolean {
  return asciiLower(a) === asciiLower(b)
}

class Parser {
  /** Unicode scalar values, as Rust's `chars()` walks them. */
  readonly chars: string[]
  /** The UTF-16 offset of each char, and of the end. */
  readonly utf16: number[]

  readonly regex: boolean

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

  refuse(message: string, from: number, to: number): Refusal {
    return new Refusal({ message, from: this.utf16[from] ?? 0, to: this.utf16[to] ?? 0 })
  }

  /** The end of the run of non-whitespace starting at `at`. */
  runEnd(at: number): number {
    let end = at
    while (end < this.chars.length && !isFilterSpace(this.chars[end])) end += 1
    return end
  }

  parse(): FilterQuery {
    const query: FilterQuery = { terms: [], words: [], regexes: [] }
    const length = this.chars.length
    let at = 0
    for (;;) {
      while (at < length && isFilterSpace(this.chars[at])) at += 1
      if (at === length) return query
      const start = at
      let negated = false
      if (this.chars[at] === '-' && at + 1 < length && !isFilterSpace(this.chars[at + 1])) {
        negated = true
        at += 1
      }
      const character = this.chars[at]
      if (character === '"') {
        const [text, end] = this.phrase(at)
        this.boundary(start, end)
        query.words.push({ text, negated, from: this.offset(start), to: this.offset(end) })
        at = end
      } else if (character === '/' && this.regex) {
        const [pattern, caseInsensitive, end] = this.regexItem(start, at)
        query.regexes.push({
          pattern,
          caseInsensitive,
          negated,
          from: this.offset(start),
          to: this.offset(end),
        })
        at = end
      } else {
        const separator = this.keyEnd(at)
        if (separator !== undefined) {
          const [term, end] = this.term(start, at, separator, negated)
          query.terms.push(term)
          at = end
        } else {
          const [text, end] = this.bare(at)
          query.words.push({ text, negated, from: this.offset(start), to: this.offset(end) })
          at = end
        }
      }
    }
  }

  offset(index: number): number {
    return this.utf16[index] ?? 0
  }

  /** After a quoted phrase: the item must end there. */
  boundary(start: number, end: number): void {
    if (end < this.chars.length && !isFilterSpace(this.chars[end]))
      throw this.refuse(SPACE_AFTER_QUOTE, start, this.runEnd(end))
  }

  /** A quoted phrase starting at `at`: its text and where it ends. */
  phrase(at: number): [string, number] {
    let text = ''
    let index = at + 1
    while (index < this.chars.length) {
      const character = this.chars[index]
      const next = this.chars[index + 1]
      if (character === '\\' && index + 1 < this.chars.length && (next === '"' || next === '\\')) {
        text += next
        index += 2
      } else if (character === '"') {
        return [text, index + 1]
      } else {
        text += character
        index += 1
      }
    }
    throw this.refuse(QUOTE_NOT_CLOSED, at, this.chars.length)
  }

  /** A `/pattern/` or `/pattern/i` item whose slash is at `at`. */
  regexItem(start: number, at: number): [string, boolean, number] {
    let pattern = ''
    let index = at + 1
    const refused = () => this.refuse(REGEX_MESSAGE, start, this.runEnd(at))
    for (;;) {
      const character = this.chars[index]
      if (character === undefined) throw refused()
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
    if (pattern === '') throw refused()
    let end = index + 1
    const caseInsensitive = this.chars[end] === 'i'
    if (caseInsensitive) end += 1
    if (end < this.chars.length && !isFilterSpace(this.chars[end])) throw refused()
    return [pattern, caseInsensitive, end]
  }

  /** Where the `:` or `=` of a term starting at `at` is, when it is one. */
  keyEnd(at: number): number | undefined {
    if (!isAsciiAlpha(this.chars[at])) return undefined
    let end = at + 1
    while (end < this.chars.length && isKeyChar(this.chars[end])) end += 1
    const separator = this.chars[end]
    return separator === ':' || separator === '=' ? end : undefined
  }

  /** A term whose item starts at `start`, key at `at`, separator at `separator`. */
  term(start: number, at: number, separator: number, negated: boolean): [FilterTerm, number] {
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
      ;[value, end] = this.phrase(index)
      this.boundary(start, end)
    } else {
      ;[value, end] = this.bare(index)
    }
    return [{ key, op, value, negated, from: this.offset(start), to: this.offset(end) }, end]
  }

  /**
   * Bare text from `at` to the next whitespace; a quote inside it is an
   * error (a quote starts a phrase only at the start of a word or value).
   */
  bare(at: number): [string, number] {
    const end = this.runEnd(at)
    for (let index = at; index < end; index += 1)
      if (this.chars[index] === '"') throw this.refuse(QUOTE_IN_WORD, index, index + 1)
    return [this.chars.slice(at, end).join(''), end]
  }
}

/** Parses `text`; `regex` says whether `/…/` is a regex item or a word. */
export function parseFilter(text: string, regex = false): FilterResult {
  try {
    return { ok: true, query: new Parser(text, regex).parse() }
  } catch (thrown) {
    if (thrown instanceof Refusal) return { ok: false, error: thrown.error }
    throw thrown
  }
}

/** Parses and validates `text` against a list's fields: what the engine does with `?q=`. */
export function checkFilter(text: string, set: FilterFieldSet): FilterResult {
  const parsed = parseFilter(text, set.regex ?? false)
  return parsed.ok ? validateFilter(parsed.query, set) : parsed
}

function spelling(op: FilterOp): string {
  switch (op) {
    case 'eq':
      return ':'
    case 'gt':
      return '>'
    case 'ge':
      return '>='
    case 'lt':
      return '<'
    case 'le':
      return '<='
  }
}

/** Whether `<` and `>` mean something for this kind. */
function ordered(kind: FilterKind): boolean {
  return (
    kind === 'path' ||
    kind === 'time' ||
    kind === 'number' ||
    kind === 'bytes' ||
    kind === 'duration'
  )
}

/**
 * Checks every term against `set`: resolves key aliases and path prefixes,
 * enum values and their aliases, each kind's value syntax, and that `<` and
 * `>` are used only on ordered kinds. The first term that fails ends it.
 */
export function validateFilter(query: FilterQuery, set: FilterFieldSet): FilterResult {
  try {
    return {
      ok: true,
      query: {
        terms: query.terms.map((term) => validateTerm(term, set)),
        words: query.words,
        regexes: query.regexes,
      },
    }
  } catch (thrown) {
    if (thrown instanceof Refusal) return { ok: false, error: thrown.error }
    throw thrown
  }
}

function validateTerm(term: FilterTerm, set: FilterFieldSet): FilterTerm {
  const refuse = (message: string) => new Refusal({ message, from: term.from, to: term.to })
  const typed = `"${term.key}:"`
  const lower = asciiLower(term.key)
  const resolved = resolveKey(term.key, lower, set)
  if (typeof resolved === 'string') throw refuse(resolved)
  const [key, field] = resolved
  if (term.op !== 'eq' && !ordered(field.kind))
    throw refuse(`"${spelling(term.op)}" works on times, numbers, sizes and durations only.`)
  let value = term.value
  switch (field.kind) {
    case 'text':
    case 'exact':
    case 'path':
      if (term.value === '') throw refuse(`${typed} needs a value.`)
      break
    case 'enum': {
      const found = enumValue(term.value, field)
      if (found === undefined) throw refuse(`${typed} is one of ${describeEnum(field)}.`)
      value = found
      break
    }
    case 'bool': {
      const lowered = asciiLower(term.value)
      if (lowered === 'true' || lowered === 'yes') value = 'true'
      else if (lowered === 'false' || lowered === 'no') value = 'false'
      else throw refuse(`${typed} is true or false.`)
      break
    }
    case 'time':
      if (parseTime(term.value, 0) === null)
        throw refuse(`${typed} needs a time, like 2026-10-01, -2h or today.`)
      break
    case 'number':
      if (parseNumber(term.value) === null) throw refuse(`${typed} needs a number, like 42 or 2.5.`)
      break
    case 'bytes':
      if (parseBytes(term.value) === null)
        throw refuse(`${typed} needs a size, like 512, 10KB or 2MB.`)
      break
    case 'duration':
      if (parseDuration(term.value) === null)
        throw refuse(`${typed} needs a duration, like 250ms, 2s or 1.5m.`)
      break
  }
  return { key, op: term.op, value, negated: term.negated, from: term.from, to: term.to }
}

/**
 * The canonical key of a term typed as `typed` (`lower` lowercased) with its
 * field, or the message for a key the set does not have.
 */
function resolveKey(
  typed: string,
  lower: string,
  set: FilterFieldSet,
): [string, FilterFieldDef] | string {
  for (const field of set.fields) {
    if (field.kind !== 'path') continue
    const prefixes = field.prefixes ?? []
    for (const prefix of prefixes) {
      if (lower.startsWith(asciiLower(prefix))) {
        const suffix = typed.slice(prefix.length)
        if (suffix === '') return needsName(prefix)
        return [`${prefix}${suffix}`, field]
      }
    }
    // The help entry's key, an alias, or a prefix without its dot names no field yet.
    const bare = prefixes.find((prefix) => sameIgnoringAsciiCase(prefix.replace(/\.+$/, ''), lower))
    if (bare !== undefined) return needsName(bare)
    if (
      sameIgnoringAsciiCase(field.key, lower) ||
      (field.aliases ?? []).some((alias) => sameIgnoringAsciiCase(alias, lower))
    )
      return needsName(prefixes[0] ?? field.key)
  }
  for (const field of set.fields) {
    if (field.kind === 'path') continue
    if (
      sameIgnoringAsciiCase(field.key, lower) ||
      (field.aliases ?? []).some((alias) => sameIgnoringAsciiCase(alias, lower))
    )
      return [field.key, field]
  }
  return unknownKey(typed, set)
}

function needsName(prefix: string): string {
  return `"${prefix}" needs a field name after it, like ${prefix}userId:u_1.`
}

function unknownKey(typed: string, set: FilterFieldSet): string {
  const names = set.fields.filter((field) => field.kind !== 'path').map((field) => field.key)
  for (const field of set.fields)
    if (field.kind === 'path') names.push(`${field.prefixes?.[0] ?? field.key}…`)
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
 * Two strings in the order Rust's `BTreeMap<String, _>` keeps them: by UTF-8
 * bytes, which is code point order (UTF-16 units disagree above U+FFFF).
 */
export function compareUtf8(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

/** An enum's aliases in the engine's order (it serves them from a sorted map). */
export function enumAliases(field: FilterFieldDef): [alias: string, value: string][] {
  return Object.entries(field.valueAliases ?? {}).toSorted(([a], [b]) => compareUtf8(a, b))
}

/** The canonical value `typed` names, case-insensitively, directly or through an alias. */
function enumValue(typed: string, field: FilterFieldDef): string | undefined {
  const direct = (field.values ?? []).find((value) => sameIgnoringAsciiCase(value, typed))
  if (direct !== undefined) return direct
  return enumAliases(field).find(([alias]) => sameIgnoringAsciiCase(alias, typed))?.[1]
}

/** `password, google.com (google), phone, anonymous`. */
function describeEnum(field: FilterFieldDef): string {
  const aliases = enumAliases(field)
  return (field.values ?? [])
    .map((value) => {
      const spellings = aliases.filter(([, target]) => target === value).map(([alias]) => alias)
      return spellings.length === 0 ? value : `${value} (${spellings.join(', ')})`
    })
    .join(', ')
}

function allAsciiDigits(text: string): boolean {
  for (const character of text) if (!isAsciiDigit(character)) return false
  return true
}

/** A decimal number: digits, an optional fraction, an optional leading minus. */
export function parseNumber(text: string): number | null {
  const digits = text.startsWith('-') ? text.slice(1) : text
  const point = digits.indexOf('.')
  const whole = point === -1 ? digits : digits.slice(0, point)
  const fraction = point === -1 ? '' : digits.slice(point + 1)
  const fractionOk = point === -1 || fraction !== ''
  if (whole === '' || !allAsciiDigits(whole) || !allAsciiDigits(fraction) || !fractionOk)
    return null
  return Number(text)
}

/** A non-negative decimal followed by a unit, the unit split off lowercased. */
function numberAndUnit(text: string): [number, string] | null {
  let split = 0
  while (split < text.length && (isAsciiDigit(text[split]) || text[split] === '.')) split += 1
  const number = text.slice(0, split)
  if (number === '' || number.startsWith('-')) return null
  const parsed = parseNumber(number)
  return parsed === null ? null : [parsed, asciiLower(text.slice(split))]
}

/** A size in bytes: `512`, `10KB`, `2MB`, `1.5GB` (any case, powers of 1024). */
export function parseBytes(text: string): number | null {
  const split = numberAndUnit(text)
  if (split === null) return null
  const [number, unit] = split
  const powers: Record<string, number> = { '': 0, b: 0, kb: 1, mb: 2, gb: 3, tb: 4 }
  const power = powers[unit]
  if (power === undefined) return null
  const bytes = number * 1024 ** power
  return Number.isFinite(bytes) ? Math.round(bytes) : null
}

/** The most seconds a Rust `Duration` holds, plus one: 2^64. */
const DURATION_SECONDS_CAP = 2 ** 64

/** A duration in milliseconds: `250ms`, `2s`, `1.5m`, `1h` (any case). */
export function parseDuration(text: string): number | null {
  const split = numberAndUnit(text)
  if (split === null) return null
  const [number, unit] = split
  const scale: Record<string, number> = { ms: 1 / 1000, s: 1, m: 60, h: 3600 }
  const factor = scale[unit]
  if (factor === undefined) return null
  const seconds = number * factor
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= DURATION_SECONDS_CAP) return null
  return seconds * 1000
}

/** The engine's calendar ends here: −9999-01-01 and 9999-12-31, UTC. */
const EARLIEST_MS = utcMs(-9999, 1, 1, 0, 0, 0)
const RELATIVE_UNITS: Record<string, bigint> = {
  s: 1n,
  m: 60n,
  h: 3_600n,
  d: 86_400n,
  w: 604_800n,
}
const I64_MAX = 9_223_372_036_854_775_807n

/**
 * A time as epoch milliseconds, relative to `now`: RFC 3339, `YYYY-MM-DD`
 * (UTC midnight), `now`, `today` (UTC midnight), or `-<n><unit>` with `s`,
 * `m`, `h`, `d` or `w` (any case). `null` when it is none of those.
 */
export function parseTime(text: string, now: number = Date.now()): number | null {
  const lower = asciiLower(text)
  if (lower === 'now') return now
  if (lower === 'today') return Math.floor(now / 86_400_000) * 86_400_000
  if (lower.startsWith('-')) {
    const relative = Array.from(lower.slice(1))
    const unit = relative.pop()
    const amount = relative.join('')
    if (unit === undefined || amount === '' || !allAsciiDigits(amount)) return null
    const scale = RELATIVE_UNITS[unit]
    if (scale === undefined) return null
    const count = BigInt(amount)
    if (count > I64_MAX) return null
    const seconds = count * scale
    if (seconds > I64_MAX) return null
    // Past the engine's calendar is a time it cannot hold, so not a time.
    if (seconds > 10n ** 13n) return null
    const at = now - Number(seconds) * 1000
    return at < EARLIEST_MS ? null : at
  }
  if (utf8Length(text) === 10) return parseDate(text)
  return parseRfc3339(text)
}

/** The UTF-8 byte length, which is what the engine's `len()` measures. */
function utf8Length(text: string): number {
  let bytes = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/** Epoch milliseconds of a proleptic Gregorian UTC instant; years 0–99 stay themselves. */
function utcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  return date.getTime()
}

/** `YYYY-MM-DD`, a real calendar day, as UTC midnight. */
function parseDate(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return utcMs(year, month, day, 0, 0, 0)
}

/**
 * RFC 3339 exactly as the engine's `time` crate reads it: any one byte
 * between the date and the time, a fraction of any length, `Z` in either
 * case or a `±HH:MM` offset under 24 hours, and a leap second only where
 * one can fall (the last second of a month, UTC).
 */
function parseRfc3339(text: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[^\u0080-￿](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      text,
    )
  if (!match) return null
  const [, y, mo, d, h, mi, s, fraction, sign, oh, om] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  let second = Number(s)
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  if (hour > 23 || minute > 59 || second > 60) return null
  const offsetHours = oh === undefined ? 0 : Number(oh)
  const offsetMinutes = om === undefined ? 0 : Number(om)
  if (offsetHours > 23 || offsetMinutes > 59) return null
  const offset = (sign === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes)
  let milliseconds = fraction === undefined ? 0 : Number(`0.${fraction.slice(0, 9)}`) * 1000
  const leap = second === 60
  if (leap) {
    // The engine reads it as the last nanosecond of second 59; a millisecond
    // is as fine as a double holds at this magnitude.
    second = 59
    milliseconds = 999
  }
  const at = utcMs(year, month, day, hour, minute, second) - offset * 60_000 + milliseconds
  if (leap) {
    const utc = new Date(at)
    const utcYear = utc.getUTCFullYear()
    if (utcYear < -9999 || utcYear > 9999) return null
    const lastDay = daysInMonth(utcYear, utc.getUTCMonth() + 1)
    if (
      utc.getUTCHours() !== 23 ||
      utc.getUTCMinutes() !== 59 ||
      utc.getUTCSeconds() !== 59 ||
      utc.getUTCDate() !== lastDay
    )
      return null
  }
  return at
}

/** Whether a value has to be quoted to read back as itself. */
function needsQuotes(value: string, asValue: boolean): boolean {
  if (value === '' || value.includes('"')) return true
  for (const character of value) if (isFilterSpace(character)) return true
  if (asValue) return value.startsWith('<') || value.startsWith('>') || value.startsWith('=')
  return false
}

/** `value` quoted for a filter: backslashes and quotes escaped. */
export function quoteFilterText(value: string): string {
  return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`
}

/** A term's value as it must be written: bare when it can be, quoted when it must. */
export function filterValueText(value: string): string {
  return needsQuotes(value, true) ? quoteFilterText(value) : value
}

function wordText(word: FilterWord, regex: boolean): string {
  const text = word.text
  const parsesAsSomethingElse =
    needsQuotes(text, false) ||
    (word.negated ? false : text.startsWith('-')) ||
    (regex && text.startsWith('/')) ||
    new Parser(text, regex).keyEnd(0) !== undefined
  return parsesAsSomethingElse ? quoteFilterText(text) : text
}

/**
 * A query written back as filter text, items in the order they were typed,
 * each quoted only where it must be so that it parses back to itself.
 */
export function printFilter(query: FilterQuery, regex = false): string {
  const items: { from: number; text: string }[] = [
    ...query.terms.map((term) => ({
      from: term.from,
      text: `${term.negated ? '-' : ''}${term.key}:${term.op === 'eq' ? '' : spelling(term.op)}${filterValueText(term.value)}`,
    })),
    ...query.words.map((word) => ({
      from: word.from,
      text: `${word.negated ? '-' : ''}${wordText(word, regex)}`,
    })),
    ...query.regexes.map((item) => ({
      from: item.from,
      text: `${item.negated ? '-' : ''}/${item.pattern}/${item.caseInsensitive ? 'i' : ''}`,
    })),
  ]
  return items
    .toSorted((a, b) => a.from - b.from)
    .map((item) => item.text)
    .join(' ')
}

/** One item of a filter as it stands while it is typed: never refused, spans in UTF-16. */
export interface FilterToken {
  /** Where the item starts, its `-` included. */
  from: number
  /** Where its body starts, after the `-`. */
  body: number
  to: number
  negated: boolean
  /** A key and its separator (`provider:`), a quoted phrase, a `/regex/`, or a bare word. */
  kind: 'term' | 'phrase' | 'regex' | 'word'
  /** For a term: where the separator is. */
  separator?: number
}

/**
 * The items of a filter, read forgivingly — an unclosed quote runs to the
 * end, nothing is refused — so a field can paint them while they are typed.
 */
export function filterTokens(text: string, regex = false): FilterToken[] {
  const tokens: FilterToken[] = []
  const length = text.length
  let at = 0
  while (at < length) {
    while (at < length && isFilterSpace(text[at])) at += 1
    if (at >= length) break
    const from = at
    let body = at
    if (text[at] === '-' && at + 1 < length && !isFilterSpace(text[at + 1])) body += 1
    let end = body
    let quoted = false
    while (end < length) {
      const character = text[end]
      if (quoted) {
        if (character === '\\' && end + 1 < length) end += 2
        else {
          if (character === '"') quoted = false
          end += 1
        }
        continue
      }
      if (isFilterSpace(character)) break
      if (character === '"') quoted = true
      end += 1
    }
    let kind: FilterToken['kind'] = 'word'
    let separator: number | undefined
    if (text[body] === '"') kind = 'phrase'
    else if (regex && text[body] === '/') kind = 'regex'
    else if (isAsciiAlpha(text[body])) {
      let key = body + 1
      while (key < end && isKeyChar(text[key])) key += 1
      if (text[key] === ':' || text[key] === '=') {
        kind = 'term'
        separator = key
      }
    }
    tokens.push({
      from,
      body,
      to: end,
      negated: body > from,
      kind,
      ...(separator === undefined ? {} : { separator }),
    })
    at = end
  }
  return tokens
}

/** What the text at the caret is, for completion. */
export type FilterContext =
  /** A key being typed, or the start of a new item: offer keys. `from`–`to` is the key's span. */
  | {
      kind: 'key'
      from: number
      to: number
      prefix: string
      hasSeparator: boolean
      negated: boolean
    }
  /** A key under one of a path field's prefixes (`data.us`): offer that field's names. */
  | {
      kind: 'path'
      from: number
      to: number
      prefix: string
      hasSeparator: boolean
      negated: boolean
      field: FilterFieldDef
    }
  /** After `key:` and its operator: offer values. `from`–`to` is the value's span, its quote included. */
  | {
      kind: 'value'
      key: string
      op: FilterOp
      from: number
      to: number
      prefix: string
      quoted: boolean
      negated: boolean
    }
  /** Plain text being typed, which completes to nothing. */
  | { kind: 'word'; from: number; to: number; prefix: string }
  /** Inside a quoted phrase or a regex. */
  | { kind: 'none' }

/**
 * What the caret is in: a key, a path key, a value or a word — the
 * completion list's question. `fields` lets a key under a path prefix be
 * told from any other key.
 */
export function contextAt(
  text: string,
  caret: number,
  options: { regex?: boolean | undefined; fields?: readonly FilterFieldDef[] | undefined } = {},
): FilterContext {
  const token = filterTokens(text, options.regex ?? false).find(
    (item) => item.from <= caret && caret <= item.to,
  )
  if (!token)
    return { kind: 'key', from: caret, to: caret, prefix: '', hasSeparator: false, negated: false }
  if (caret < token.body)
    return {
      kind: 'key',
      from: token.body,
      to: token.body,
      prefix: '',
      hasSeparator: false,
      negated: false,
    }
  if (token.kind === 'phrase' || token.kind === 'regex') return { kind: 'none' }
  const { body, negated } = token
  if (token.kind === 'term' && token.separator !== undefined && caret > token.separator) {
    let start = token.separator + 1
    let op: FilterOp = 'eq'
    const first = text[start]
    const second = text[start + 1]
    if (first === '>' && second === '=') {
      op = 'ge'
      start += 2
    } else if (first === '<' && second === '=') {
      op = 'le'
      start += 2
    } else if (first === '>') {
      op = 'gt'
      start += 1
    } else if (first === '<') {
      op = 'lt'
      start += 1
    }
    const quoted = text[start] === '"'
    const valueFrom = quoted ? start + 1 : start
    return {
      kind: 'value',
      key: text.slice(body, token.separator),
      op,
      from: start,
      to: token.to,
      prefix: caret > valueFrom ? text.slice(valueFrom, caret) : '',
      quoted,
      negated,
    }
  }
  const typed = text.slice(body, caret)
  const keyShaped =
    typed === '' ||
    (isAsciiAlpha(typed[0]) && Array.from(typed).every((character) => isKeyChar(character)))
  if (!keyShaped) return { kind: 'word', from: body, to: token.to, prefix: typed }
  let keyEnd = body
  while (keyEnd < token.to && isKeyChar(text[keyEnd])) keyEnd += 1
  const hasSeparator = text[keyEnd] === ':' || text[keyEnd] === '='
  const lower = asciiLower(typed)
  const field = options.fields?.find(
    (item) =>
      item.kind === 'path' &&
      (item.prefixes ?? []).some((prefix) => lower.startsWith(asciiLower(prefix))),
  )
  if (field)
    return { kind: 'path', from: body, to: keyEnd, prefix: typed, hasSeparator, negated, field }
  return { kind: 'key', from: body, to: keyEnd, prefix: typed, hasSeparator, negated }
}

/** The field a typed key names — by key, alias or path prefix — or `undefined`. */
export function fieldFor(
  key: string,
  fields: readonly FilterFieldDef[],
): FilterFieldDef | undefined {
  const lower = asciiLower(key)
  const path = fields.find(
    (field) =>
      field.kind === 'path' &&
      (field.prefixes ?? []).some((prefix) => lower.startsWith(asciiLower(prefix))),
  )
  if (path) return path
  return fields.find(
    (field) =>
      field.kind !== 'path' &&
      (sameIgnoringAsciiCase(field.key, lower) ||
        (field.aliases ?? []).some((alias) => sameIgnoringAsciiCase(alias, lower))),
  )
}
