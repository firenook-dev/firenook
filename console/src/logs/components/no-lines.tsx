// Nothing matches: which filter hides how many lines, from the engine's
// facets (each dimension is counted with every other filter applied, so
// what it hides is its own count less what matches), plus the engine
// internals the default view leaves out, and one way out.

import type { LogFacetCount } from '@/api/generated/observe/LogFacetCount'
import type { LogFacets } from '@/api/generated/observe/LogFacets'
import { NoMatch } from '@/components/console/empty-state'
import { parseFilter } from '@/lib/filter'
import { formatNumber } from '@/lib/format'

/** One dimension and the lines its terms hide. */
interface Hidden {
  what: string
  lines: number
}

const DIMENSIONS: readonly {
  key: string
  counts: (facets: LogFacets) => readonly LogFacetCount[]
  /** How it is named when its terms are not shown one by one. */
  name?: string
}[] = [
  { key: 'level', counts: (facets) => facets.levels, name: 'the level filter' },
  { key: 'service', counts: (facets) => facets.services },
  { key: 'function', counts: (facets) => facets.functions },
  { key: 'instance', counts: (facets) => facets.instances },
  { key: 'codebase', counts: (facets) => facets.codebases },
  { key: 'kind', counts: (facets) => facets.kinds, name: 'the kind filter' },
]

/** What each faceted filter of `q` hides, most first. */
export function hiddenBy(q: string, facets: LogFacets): Hidden[] {
  const parsed = parseFilter(q, true)
  if (!parsed.ok) return []
  const hidden: Hidden[] = []
  for (const dimension of DIMENSIONS) {
    const terms = parsed.query.terms.filter((term) => term.key.toLowerCase() === dimension.key)
    if (terms.length === 0) continue
    const total = dimension.counts(facets).reduce((sum, count) => sum + count.count, 0)
    const lines = total - facets.matched
    if (lines <= 0) continue
    const what = dimension.name ?? terms.map((term) => q.slice(term.from, term.to)).join(' ')
    hidden.push({ what, lines })
  }
  return hidden.toSorted((a, b) => b.lines - a.lines)
}

/** "1,180 lines are hidden by function:hello, 12 by the level filter, 6 engine internals." */
export function hiddenSentence(hidden: readonly Hidden[], internals: number): string | undefined {
  const parts = hidden.map((item, index) =>
    index === 0
      ? `${formatNumber(item.lines)} ${item.lines === 1 ? 'line is' : 'lines are'} hidden by ${item.what}`
      : `${formatNumber(item.lines)} by ${item.what}`,
  )
  if (internals > 0)
    parts.push(
      `${formatNumber(internals)} ${internals === 1 ? 'engine internal' : 'engine internals'}${
        hidden.length === 0 ? ` ${internals === 1 ? 'is' : 'are'} left out` : ''
      }`,
    )
  return parts.length > 0 ? `${parts.join(', ')}.` : undefined
}

export function NoLines({
  q,
  facets,
  windowed,
  onClear,
}: {
  q: string
  facets: LogFacets | undefined
  windowed: boolean
  onClear: () => void
}) {
  const sentence = facets ? hiddenSentence(hiddenBy(q, facets), facets.internalHidden) : undefined
  // The shared no-match state — title, the filter in a chip, the way out —
  // with what only Logs can say about why under the chip.
  return (
    <NoMatch filter={q} onClear={onClear} noun="lines" testId="logs-no-match">
      {sentence && (
        <p
          className="m-0 max-w-[560px] text-center text-[13px] text-kumo-subtle"
          data-testid="logs-hidden-by"
        >
          {sentence}
        </p>
      )}
      {windowed && (
        <p className="m-0 max-w-[560px] text-center text-[13px] text-kumo-subtle">
          The time range leaves out every line outside it.
        </p>
      )}
    </NoMatch>
  )
}
