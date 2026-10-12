// The Logs section panel: the shape of the stream before reading it. One
// `FacetList` group per dimension the engine counts — Level, Kind (problem
// kinds first, engine internals last), Service, Function, Extension,
// Codebase — each value with how many lines carry it, counted by the engine
// with every other filter applied. Pressing a value narrows to it; Only and
// Hide (on hover and on keyboard focus) replace the group's terms or
// exclude the value. The panel writes `q`, so the field, the URL and these
// rows are one truth.
//
// Level is always shown; any other group with one value or none says
// nothing a reader needs and is left out — except Kind while it holds the
// engine internals the default view leaves out, the one switch that brings
// them back.

import { Button, Tooltip } from '@cloudflare/kumo'
import { useState } from 'react'
import type { LogFacetCount } from '@/api/generated/observe/LogFacetCount'
import type { LogFacets } from '@/api/generated/observe/LogFacets'
import { type Facet, type FacetGroup, FacetList } from '@/components/console/facet-list'
import { PanelFilter } from '@/components/console/panel'
import { PanelToggle, SectionPanel } from '@/components/shell/section-panel'
import { filterValueText, parseFilter } from '@/lib/filter'
import { INTERNAL_FACET_LABEL, kindFacetLabel, kindFacets } from '@/observe/kinds'

/** The keys the panel writes: what Reset takes out. */
const FACET_KEYS = new Set(['level', 'service', 'function', 'instance', 'codebase', 'kind', 'is'])

/** Values past which a group gets its own filter. */
const FILTER_AFTER = 12

const LEVELS: readonly { value: string; label: string; tone?: Facet['tone'] }[] = [
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warning', tone: 'warning' },
  { value: 'error', label: 'Error', tone: 'danger' },
]

/** `q` without the terms the panel writes, each removed by its own span; the rest as typed. */
export function withoutFacetTerms(q: string): string {
  const parsed = parseFilter(q, true)
  if (!parsed.ok) return q
  let text = q
  const gone = parsed.query.terms
    .filter((term) => FACET_KEYS.has(term.key.toLowerCase()))
    .toSorted((a, b) => b.from - a.from)
  for (const term of gone) {
    const left = text.slice(0, term.from).replace(/\s+$/, '')
    const right = text.slice(term.to).replace(/^\s+/, '')
    text = left && right ? `${left} ${right}` : left || right
  }
  return text
}

/** Whether `q` holds a term the panel writes. */
export function hasFacetTerms(q: string): boolean {
  const parsed = parseFilter(q, true)
  return parsed.ok && parsed.query.terms.some((term) => FACET_KEYS.has(term.key.toLowerCase()))
}

/** One facet per value of a dimension; "Other" (past the engine's 4,096 labels) cannot be written. */
function valueFacets(key: string, counts: readonly LogFacetCount[]): Facet[] {
  return counts
    .filter((count) => count.value !== 'Other' && count.count > 0)
    .map((count) => ({
      term: `${key}:${filterValueText(count.value)}`,
      label: count.value,
      count: count.count,
    }))
}

/** The panel's groups for the engine's counts. */
export function facetGroups(facets: LogFacets | undefined): {
  level: FacetGroup
  rest: FacetGroup[]
  functions: Facet[]
} {
  const levels = new Map(facets?.levels.map((count) => [count.value, count.count]))
  const level: FacetGroup = {
    label: 'Level',
    facets: LEVELS.map((entry) => ({
      term: `level:${entry.value}`,
      label: entry.label,
      count: levels.get(entry.value) ?? (facets ? 0 : undefined),
      tone: entry.tone,
    })),
  }
  const kinds = kindFacets(facets?.kinds ?? [], facets?.internalHidden ?? 0)
  const kindRows: Facet[] = [...kinds.problems, ...kinds.others].map((count) => ({
    term: `kind:${filterValueText(count.value)}`,
    label: kindFacetLabel(count.value),
    count: count.count,
  }))
  if (kinds.internal > 0)
    kindRows.push({ term: 'is:internal', label: INTERNAL_FACET_LABEL, count: kinds.internal })
  const rest: FacetGroup[] = []
  if (kindRows.length > 0) rest.push({ label: 'Kind', facets: kindRows })
  const services = valueFacets('service', facets?.services ?? [])
  if (services.length > 1) rest.push({ label: 'Service', facets: services })
  return { level, rest, functions: valueFacets('function', facets?.functions ?? []) }
}

/** The groups after Function: Extension and Codebase, shown with more than one value. */
function laterGroups(facets: LogFacets | undefined): FacetGroup[] {
  const groups: FacetGroup[] = []
  const instances = valueFacets('instance', facets?.instances ?? [])
  if (instances.length > 1) groups.push({ label: 'Extension', facets: instances })
  const codebases = valueFacets('codebase', facets?.codebases ?? [])
  if (codebases.length > 1) groups.push({ label: 'Codebase', facets: codebases })
  return groups
}

export function FacetsPanel({
  q,
  onChange,
  facets,
}: {
  q: string
  onChange: (q: string) => void
  facets: LogFacets | undefined
}) {
  const [functionFilter, setFunctionFilter] = useState('')
  const { level, rest, functions } = facetGroups(facets)
  const later = laterGroups(facets)
  const typed = functionFilter.trim().toLowerCase()
  const shownFunctions =
    typed === ''
      ? functions
      : functions.filter((facet) => facet.label.toLowerCase().includes(typed))
  return (
    <SectionPanel label="Filters">
      <div
        className="flex h-11 shrink-0 items-center gap-1.5 border-b border-kumo-line px-3"
        data-testid="panel-header"
      >
        <PanelToggle where="panel" />
        {/* The panel's name as every section's panel names itself: a quiet
            12 px label beside the toggle, not a title. */}
        <div className="flex min-w-0 flex-1 items-center">
          <span className="truncate text-[12px] text-kumo-subtle">Filters</span>
        </div>
        {hasFacetTerms(q) && (
          <Tooltip
            content="Take out what the panel added; words and the rest stay"
            render={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange(withoutFacetTerms(q))}
                data-testid="facets-reset"
              >
                Reset
              </Button>
            }
          />
        )}
      </div>
      <div
        className="grid min-h-0 flex-1 content-start gap-4 overflow-x-hidden overflow-y-auto px-1.5 py-3"
        data-testid="logs-facets"
      >
        <FacetList groups={[level, ...rest]} value={q} onChange={onChange} testId="facets-main" />
        {functions.length > 1 && (
          <div className="grid gap-1.5">
            {functions.length > FILTER_AFTER && (
              <div className="px-1">
                <PanelFilter
                  value={functionFilter}
                  onChange={setFunctionFilter}
                  placeholder="Filter functions"
                  testId="facets-function-filter"
                />
              </div>
            )}
            <FacetList
              groups={[{ label: 'Function', facets: shownFunctions }]}
              value={q}
              onChange={onChange}
              testId="facets-functions"
            />
          </div>
        )}
        {later.length > 0 && (
          <FacetList groups={later} value={q} onChange={onChange} testId="facets-later" />
        )}
      </div>
    </SectionPanel>
  )
}
