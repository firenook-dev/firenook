// How often each rule ran, from the engine's coverage report — the same
// report the official emulator serves at `…:ruleCoverage`, counting what
// the evaluator actually visited. Firestore's comes from that route,
// Storage's from `/storage/rules/coverage`, in the one official shape, so
// this file reads both unchanged. A page asks for it again whenever a new
// decision arrives on its feed, so the counts move as the app makes
// requests, without polling.

import { type QueryKey, queryOptions } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import type { CodeGutterNote, CodeInlineValue } from '@/components/code-editor'
import { type RulesTypedValue, rulesValueText } from './typed-value'

interface CoverageNode {
  sourcePosition: { line: number; column: number; currentOffset: number; endOffset: number }
  values?: Array<{ value: RulesTypedValue; count: number }>
  children?: CoverageNode[]
}

export interface CoverageReport {
  rules: { files: Array<{ name: string; content: string }> }
  /**
   * Absent, not empty, when the rules have no expression to count — a
   * ruleset of `if true` and `if false` alone, as the official format does.
   */
  report?: CoverageNode[]
  firenookCoverage?: { truncated?: boolean }
}

/** The report at `url` (a console URL), under `queryKey`; null when there is nothing to count. */
export const coverageQueryOptions = (queryKey: QueryKey, url: string) =>
  queryOptions({
    queryKey,
    queryFn: async (): Promise<CoverageReport | null> => {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      // No rules loaded, or diagnostics off: nothing to count, which is
      // not an error worth a red line on the page.
      if (response.status === 404 || response.status === 503) return null
      if (!response.ok)
        throw new ApiError(response.status, `${response.status} ${response.statusText}`)
      return (await response.json()) as CoverageReport
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })

/**
 * Offsets in the report count Unicode scalars; the editor counts UTF-16
 * code units. A table from one to the other, built once per source.
 */
export function scalarToUtf16(source: string): (scalar: number) => number {
  const table: number[] = []
  let unit = 0
  for (const character of source) {
    table.push(unit)
    unit += character.length
  }
  table.push(unit)
  return (scalar) => table[Math.min(Math.max(0, scalar), table.length - 1)] ?? unit
}

function total(node: CoverageNode): number {
  return (node.values ?? []).reduce((sum, item) => sum + item.count, 0)
}

/** The parts of a condition no request ever reached, shortest first-level ones. */
function unreached(node: CoverageNode, source: string, toUnit: (s: number) => number): string[] {
  const out: string[] = []
  for (const child of node.children ?? []) {
    if (total(child) === 0) {
      out.push(
        source.slice(
          toUnit(child.sourcePosition.currentOffset),
          toUnit(child.sourcePosition.endOffset + 1),
        ),
      )
    } else out.push(...unreached(child, source, toUnit))
  }
  return out
}

/** What each value a condition produced, and how often: `false ×2 · true ×1`. */
function tally(node: CoverageNode): string {
  return (node.values ?? [])
    .map((item) => `${rulesValueText(item.value) ?? '?'} ×${item.count}`)
    .join(' · ')
}

export interface CoverageView {
  notes: CodeGutterNote[]
  tallies: CodeInlineValue[]
  /** Conditions that ran at least once, of all the report knows. */
  ran: number
  of: number
}

/**
 * The report as the editor draws it: a count in the gutter beside each
 * condition — or "never" when no request reached it — and, after each
 * condition, the values it produced. Only for the text it describes.
 */
export function coverageView(
  report: CoverageReport | null | undefined,
  source: string,
): CoverageView | undefined {
  if (!report || report.rules.files[0]?.content !== source) return undefined
  const toUnit = scalarToUtf16(source)
  const notes: CodeGutterNote[] = []
  const tallies: CodeInlineValue[] = []
  let ran = 0
  const nodes = report.report ?? []
  for (const node of nodes) {
    const count = total(node)
    const line = node.sourcePosition.line
    const to = toUnit(node.sourcePosition.endOffset + 1)
    if (count === 0) {
      notes.push({
        line,
        text: 'never',
        tone: 'miss',
        title: 'No request has reached this condition since these rules were loaded',
      })
      continue
    }
    ran += 1
    const missing = unreached(node, source, toUnit)
    notes.push({
      line,
      text: `${count}×`,
      tone: 'hit',
      title:
        missing.length > 0
          ? `Ran ${count} times; never reached: ${missing.join(', ')}`
          : `Ran ${count} times`,
    })
    tallies.push({ from: toUnit(node.sourcePosition.currentOffset), to, value: tally(node) })
  }
  return { notes, tallies, ran, of: nodes.length }
}
