// The Functions pages' filters, in the console's one filter language.
//
// - The overview's (`/functions` with no function open) is applied here,
//   over the snapshot, which holds every function: `kind:` `status:`
//   `codebase:` `region:` and words over the name, the id and the trigger.
// - The invocation filter (`/functions/invocations`, the function page's
//   list, the `functions.events` topic's `q`) is the engine's: the fields
//   below mirror its `INVOCATION_FIELDS`, held to them by the golden cases
//   in `invocation-filter-cases.json`, which the Rust side runs too. The
//   engine applies it to the page and the live tail alike; the client only
//   checks it as you type.

import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import type { FunctionNotLoaded } from '@/api/generated/compute/FunctionNotLoaded'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import type { FilterFieldSpec } from '@/components/console/filter-field'
import { KIND_WORDS } from '@/compute/kind-badge'
import {
  type FilterQuery,
  type FilterTerm,
  asciiLower,
  checkFilter,
  parseFilter,
  printFilter,
} from '@/lib/filter'
import { orderedCodebases } from './functions-tree'
import { triggerText } from './trigger-text'

// ── The overview ─────────────────────────────────────────────────────────

/** An overview row: a function, or a function the emulator dropped at load. */
export type OverviewRow =
  | { kind: 'function'; key: string; summary: FunctionSummary }
  | {
      kind: 'notLoaded'
      key: string
      codebase: string
      entry: FunctionNotLoaded
      region: string
      name: string
    }

/** The overview's status words: the engine's five, and the ones dropped at load. */
export const OVERVIEW_STATUSES = [
  'receiving',
  'ignored',
  'noService',
  'paused',
  'removed',
  'notLoaded',
] as const

export const OVERVIEW_FIELDS: readonly FilterFieldSpec[] = [
  {
    key: 'kind',
    kind: 'enum',
    help: 'How the function is triggered',
    values: [...KIND_WORDS],
  },
  {
    key: 'status',
    kind: 'enum',
    help: 'Receiving, or why it receives nothing',
    values: [...OVERVIEW_STATUSES],
    valueAliases: {
      'no-service': 'noService',
      noservice: 'noService',
      'not-loaded': 'notLoaded',
      notloaded: 'notLoaded',
    },
  },
  {
    key: 'codebase',
    kind: 'exact',
    help: 'Codebase or extension instance; end with * for a prefix',
  },
  { key: 'region', kind: 'exact', help: 'Region, like us-central1' },
]

/** `us-central1-onConfig` → `onConfig`. */
function nameOf(id: string): string {
  return id.replace(/^[a-z]+-[a-z]+\d+-/, '')
}

/** `us-central1-onConfig` → `us-central1`. */
function regionOf(id: string): string {
  return /^([a-z]+-[a-z]+\d+)-/.exec(id)?.[1] ?? ''
}

/** Every row the overview can show: each function, then each one dropped at load. */
export function overviewRows(snapshot: FunctionsSnapshot): OverviewRow[] {
  const rows: OverviewRow[] = snapshot.functions.map((summary) => ({
    kind: 'function',
    key: summary.id,
    summary,
  }))
  for (const entry of orderedCodebases(snapshot.codebases))
    for (const dropped of entry.codebase.notLoaded)
      rows.push({
        kind: 'notLoaded',
        key: `not-loaded:${entry.codebase.id}:${dropped.id}`,
        codebase: entry.codebase.id,
        entry: dropped,
        region: regionOf(dropped.id),
        name: nameOf(dropped.id),
      })
  return rows
}

function rowValue(row: OverviewRow, key: string): string | undefined {
  if (row.kind === 'notLoaded') {
    if (key === 'status') return 'notLoaded'
    if (key === 'codebase') return row.codebase
    if (key === 'region') return row.region
    return undefined
  }
  const summary = row.summary
  if (key === 'kind') return summary.kind
  if (key === 'status') return summary.status
  if (key === 'codebase') return summary.codebase
  if (key === 'region') return summary.region
  return undefined
}

function rowWords(row: OverviewRow): string {
  if (row.kind === 'notLoaded')
    return asciiLower(`${row.name} ${row.entry.id} ${row.entry.eventType} ${row.entry.reason}`)
  const summary = row.summary
  return asciiLower(`${summary.name} ${summary.id} ${summary.entryPoint} ${triggerText(summary)}`)
}

/** An exact value as the engine matches it: whole, or a prefix when it ends with `*`. */
export function exactMatches(actual: string, wanted: string): boolean {
  if (wanted.endsWith('*')) return actual.startsWith(wanted.slice(0, -1))
  return actual === wanted
}

function termHolds(row: OverviewRow, term: FilterTerm): boolean {
  const actual = rowValue(row, term.key)
  if (actual === undefined) return false
  if (term.key === 'codebase' || term.key === 'region') return exactMatches(actual, term.value)
  return actual === term.value
}

/**
 * Whether a row passes a validated query: every word appears; for each key,
 * one of its plain terms holds; no negated term holds.
 */
export function rowMatches(row: OverviewRow, query: FilterQuery): boolean {
  const words = rowWords(row)
  for (const word of query.words) {
    const found = words.includes(asciiLower(word.text))
    if (found === word.negated) return false
  }
  const byKey = new Map<string, FilterTerm[]>()
  for (const term of query.terms) {
    if (term.negated) {
      if (termHolds(row, term)) return false
      continue
    }
    const list = byKey.get(term.key)
    if (list) list.push(term)
    else byKey.set(term.key, [term])
  }
  for (const terms of byKey.values()) if (!terms.some((term) => termHolds(row, term))) return false
  return true
}

/** The overview rows `q` keeps; all of them for an empty or unreadable filter (the field says why). */
export function filterOverview(rows: readonly OverviewRow[], q: string): OverviewRow[] {
  if (q.trim() === '') return [...rows]
  const result = checkFilter(q, { fields: OVERVIEW_FIELDS })
  if (!result.ok) return [...rows]
  return rows.filter((row) => rowMatches(row, result.query))
}

// ── Invocations ──────────────────────────────────────────────────────────

/** Completions from a list: the values that start with what is typed, at most twenty. */
function startingWith(values: readonly string[] | undefined) {
  return (prefix: string) => (values ?? []).filter((value) => value.startsWith(prefix)).slice(0, 20)
}

/** The engine's invocation fields (`INVOCATION_FIELDS`), with completions where the page has them. */
export function invocationFields(options: {
  functionIds?: readonly string[] | undefined
  codebases?: readonly string[] | undefined
}): FilterFieldSpec[] {
  return [
    {
      key: 'function',
      aliases: ['fn'],
      kind: 'exact',
      help: 'Function id, like us-central1-api',
      suggest: startingWith(options.functionIds),
    },
    {
      key: 'codebase',
      kind: 'exact',
      help: 'Codebase or extension instance',
      suggest: startingWith(options.codebases),
    },
    { key: 'kind', kind: 'enum', help: 'How the function is triggered', values: [...KIND_WORDS] },
    { key: 'topic', kind: 'exact', help: 'Pub/Sub or schedule topic, by name or full name' },
    {
      key: 'queue',
      kind: 'exact',
      help: 'Cloud Tasks queue key, like demo-project-us-central1-resize',
    },
    {
      key: 'outcome',
      kind: 'enum',
      help: 'Succeeded, failed, skipped or still running',
      values: ['succeeded', 'failed', 'skipped', 'running'],
    },
    {
      key: 'origin',
      kind: 'enum',
      help: 'Who made the call',
      values: ['console', 'replay', 'emulator', 'client'],
    },
    { key: 'status', kind: 'number', help: 'HTTP status the function answered with' },
    { key: 'took', kind: 'duration', help: 'How long it ran, like >200ms' },
    { key: 'at', kind: 'time', help: 'When it started' },
    { key: 'is', kind: 'enum', help: 'A cold start or a replay', values: ['cold', 'replay'] },
  ]
}

const FAILED = 'outcome:failed'

/** Whether `q` holds the plain term `outcome:failed` (what "Failed only" and `e` show). */
export function hasFailedOnly(q: string): boolean {
  const parsed = parseFilter(q)
  if (!parsed.ok) return false
  return parsed.query.terms.some(
    (term) =>
      !term.negated &&
      term.op === 'eq' &&
      asciiLower(term.key) === 'outcome' &&
      asciiLower(term.value) === 'failed',
  )
}

/**
 * `q` with `outcome:failed` added or taken out, leaving every other term
 * and word as it was: "Failed only" and `e` on the function page and on
 * Invocations.
 */
export function toggleFailedOnly(q: string): string {
  const parsed = parseFilter(q)
  if (!parsed.ok) return q.trim() === '' ? FAILED : `${q.trim()} ${FAILED}`
  if (!hasFailedOnly(q)) return q.trim() === '' ? FAILED : `${q.trim()} ${FAILED}`
  const query: FilterQuery = {
    ...parsed.query,
    terms: parsed.query.terms.filter(
      (term) =>
        !(
          !term.negated &&
          term.op === 'eq' &&
          asciiLower(term.key) === 'outcome' &&
          asciiLower(term.value) === 'failed'
        ),
    ),
  }
  return printFilter(query)
}

/**
 * The scope term the panel tree writes on Invocations — `function:<id>` or
 * `codebase:<id>`, or none — in place of whichever one `q` held.
 */
export function withScopeTerm(
  q: string,
  scope: { function: string } | { codebase: string } | undefined,
): string {
  const parsed = parseFilter(q)
  const rest = parsed.ok
    ? printFilter({
        ...parsed.query,
        terms: parsed.query.terms.filter((term) => {
          const key = asciiLower(term.key)
          return term.negated || (key !== 'function' && key !== 'fn' && key !== 'codebase')
        }),
      })
    : q.trim()
  if (!scope) return rest
  const term = 'function' in scope ? `function:${scope.function}` : `codebase:${scope.codebase}`
  return rest === '' ? term : `${term} ${rest}`
}

/** The function or codebase `q`'s scope term names, for the panel's lit row and row one's label. */
export function scopeOf(q: string): { function: string } | { codebase: string } | undefined {
  const parsed = parseFilter(q)
  if (!parsed.ok) return undefined
  const plain = parsed.query.terms.filter((term) => !term.negated && term.op === 'eq')
  const fn = plain.filter((term) => ['function', 'fn'].includes(asciiLower(term.key)))
  const codebase = plain.filter((term) => asciiLower(term.key) === 'codebase')
  if (fn.length === 1 && codebase.length === 0 && !fn[0]?.value.endsWith('*'))
    return { function: fn[0]?.value ?? '' }
  if (codebase.length === 1 && fn.length === 0 && !codebase[0]?.value.endsWith('*'))
    return { codebase: codebase[0]?.value ?? '' }
  return undefined
}
