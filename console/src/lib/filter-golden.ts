// The golden-case harness every filter cases file runs through — the
// browser half of the engine's `filter::golden::run`. The grammar's own
// cases live in `filter-cases.json`; each section keeps a file of its own in
// the same format beside its code (its fields, its examples, its messages)
// and runs it from a Vitest file with one line:
//
//   import cases from './users-filter-cases.json'
//   describe('the users filter', () => runGoldenCases(cases))
//
// One Vitest `it` per case, named after the case, so a failure says which
// text broke and how. Test-only: nothing in the app imports this.

import { expect, it } from 'vitest'
import { type FilterFieldDef, type FilterKind, type FilterQuery, checkFilter } from './filter'

/** A field as a cases file writes it: every list but the key and kind optional. */
export interface GoldenField {
  key: string
  aliases?: string[]
  kind: string
  help?: string
  values?: string[]
  valueAliases?: Record<string, string>
  prefixes?: string[]
}

export interface GoldenCase {
  /** What the case is called in the test output; the text when absent. */
  name?: string
  text: string
  /** Overrides the file's `regex` for this case. */
  regex?: boolean
  /** The parsed and validated query; a missing list is empty. */
  ok?: Partial<FilterQuery>
  error?: { from: number; to: number; message: string }
  /** For people. */
  note?: string
}

export interface GoldenFile {
  /** For people. */
  note?: string
  /** Whether `/regex/` items are items in this field set. */
  regex?: boolean
  fields: GoldenField[]
  cases: GoldenCase[]
}

const KINDS: ReadonlySet<string> = new Set<FilterKind>([
  'text',
  'exact',
  'enum',
  'path',
  'bool',
  'time',
  'number',
  'bytes',
  'duration',
])
const FILE_KEYS = new Set(['note', 'regex', 'fields', 'cases'])
const FIELD_KEYS = new Set(['key', 'aliases', 'kind', 'help', 'values', 'valueAliases', 'prefixes'])
const CASE_KEYS = new Set(['name', 'text', 'regex', 'ok', 'error', 'note'])
const ERROR_KEYS = new Set(['from', 'to', 'message'])

/**
 * The engine reads a cases file with unknown fields denied, so a file it
 * would refuse is refused here too, with the same complaint: a misspelt
 * `valueAlias` that silently meant nothing would pass on one side only.
 */
function unknownKeys(what: string, object: object, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(object))
    if (!allowed.has(key)) throw new Error(`${what}: unknown field "${key}"`)
}

function fieldOf(field: GoldenField): FilterFieldDef {
  unknownKeys(`field ${field.key}`, field, FIELD_KEYS)
  if (!KINDS.has(field.kind)) throw new Error(`field ${field.key}: unknown kind ${field.kind}`)
  return {
    key: field.key,
    aliases: field.aliases ?? [],
    kind: field.kind as FilterKind,
    help: field.help ?? '',
    values: field.values ?? [],
    valueAliases: field.valueAliases ?? {},
    prefixes: field.prefixes ?? [],
  }
}

/** The query a case's `ok` describes, with its missing lists filled in. */
function expected(ok: Partial<FilterQuery>): FilterQuery {
  return { terms: ok.terms ?? [], words: ok.words ?? [], regexes: ok.regexes ?? [] }
}

/**
 * Registers one Vitest test per case of a cases file: parse, validate, and
 * compare the query — or the error, message and UTF-16 span — exactly.
 * Returns how many cases it registered.
 */
export function runGoldenCases(file: GoldenFile): number {
  unknownKeys('the cases file', file, FILE_KEYS)
  const fields = file.fields.map(fieldOf)
  for (const [index, entry] of file.cases.entries()) {
    const label = entry.name ?? entry.text
    it(label, () => {
      unknownKeys(`case ${index} (${label})`, entry, CASE_KEYS)
      if ((entry.ok === undefined) === (entry.error === undefined))
        throw new Error(`case ${label}: a case has exactly one of ok and error`)
      const result = checkFilter(entry.text, { fields, regex: entry.regex ?? file.regex ?? false })
      if (entry.ok !== undefined) {
        expect(result).toEqual({ ok: true, query: expected(entry.ok) })
      } else if (entry.error !== undefined) {
        unknownKeys(`case ${label}'s error`, entry.error, ERROR_KEYS)
        expect(result).toEqual({ ok: false, error: entry.error })
      }
    })
  }
  return file.cases.length
}
