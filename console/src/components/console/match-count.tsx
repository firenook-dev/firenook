// How many things a list's filter matches, as the figure alone — `240 users`
// — in a slot as wide as the largest figure it will hold. The field beside it
// takes whatever the row has left, so a count that grew or shrank moved the
// controls beside it: 240 to 67 documents slid Run 12 px under the pointer.
// The slot is sized by an invisible copy of the widest figure in the same
// grid cell, in the same type, so it holds whatever the font.
//
// What the figure counts, and how it was counted, is in the tooltip. It was
// printed beside the figure as `count 19 ms`, which read as a second number
// nobody could place.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import type { Total } from '@/api/generated/Total'
import { formatNumber } from '@/lib/format'

export interface CountNoun {
  one: string
  other: string
}

/** What the tooltip says when the caller does not say it. */
export function matchCountTooltip(
  total: Total,
  noun: CountNoun,
  scanned: number | undefined,
): string {
  if (scanned !== undefined)
    return `Searched ${formatNumber(scanned)} ${scanned === 1 ? noun.one : noun.other} so far and found ${formatNumber(total.count)}; more are searched as you scroll.`
  if (!total.exact)
    return `At least ${formatNumber(total.count)} ${total.count === 1 ? noun.one : noun.other} match; counting stopped there.`
  return `Every ${noun.one} this filter matches, not only the rows loaded.`
}

export function MatchCount({
  total,
  scanned,
  noun,
  loading = false,
  widest,
  detail,
  stale,
  tooltip,
  failed = false,
  hidden = false,
  testId = 'match-count',
}: {
  total: Total | undefined
  /** How many items the engine examined before its scan budget stopped it (`Page.scanned`). */
  scanned?: number | undefined
  noun: CountNoun
  /** The count is on its way: an ellipsis holds the slot. Without a total and not loading, the slot is empty (the engine does not know). */
  loading?: boolean
  /** The widest figure the slot must hold, as it is printed: `0,000,000`. */
  widest: string
  /** Follows the figure: "240 objects · 38 MB". */
  detail?: string | undefined
  /** A view the engine says is behind: "1,204 changes · Refresh", before the figure. */
  stale?: { count: number; onRefresh: () => void } | undefined
  /** What the figure counts, when the default sentence is not right for this list. */
  tooltip?: string | undefined
  /** The count could not be read: the slot says so instead of a figure. */
  failed?: boolean
  /** Nothing to count (a filter that did not parse): the slot stays, empty, so nothing moves. */
  hidden?: boolean
  testId?: string
}) {
  const searched = scanned !== undefined && total !== undefined && !total.exact
  return (
    <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      {stale && stale.count > 0 && (
        <Button
          variant="ghost"
          size="xs"
          onClick={stale.onRefresh}
          data-testid={`${testId}-refresh`}
        >
          <span className="font-mono tabular-nums">{formatNumber(stale.count)}</span>
          {stale.count === 1 ? ' change' : ' changes'} · Refresh
        </Button>
      )}
      <span className="grid justify-items-end">
        <span aria-hidden className="invisible col-start-1 row-start-1">
          <Figure number={widest} noun={noun.other} detail={detail} />
        </span>
        {hidden ? null : total ? (
          <Tooltip
            content={tooltip ?? matchCountTooltip(total, noun, searched ? scanned : undefined)}
            render={
              <span
                className="col-start-1 row-start-1 cursor-default"
                data-testid={testId}
                data-exact={total.exact ? '' : undefined}
              >
                {searched ? (
                  <Figure number={`${formatNumber(scanned)}+`} noun="searched" detail={detail} />
                ) : (
                  <Figure
                    number={`${formatNumber(total.count)}${total.exact ? '' : '+'}`}
                    noun={total.count === 1 && total.exact ? noun.one : noun.other}
                    detail={detail}
                  />
                )}
              </span>
            }
          />
        ) : failed || loading ? (
          <span className="col-start-1 row-start-1" data-testid={testId}>
            <Text variant="secondary" size="sm" as="span" DANGEROUS_className="text-[12px]">
              {failed ? <span className="text-kumo-danger">Count unavailable</span> : '…'}
            </Text>
          </span>
        ) : null}
      </span>
    </span>
  )
}

function Figure({
  number,
  noun,
  detail,
}: {
  number: string
  noun: string
  detail?: string | undefined
}) {
  return (
    <Text variant="secondary" size="sm" as="span" DANGEROUS_className="text-[12px]">
      <span className="font-mono text-[0.95em] text-kumo-default tabular-nums">{number}</span>{' '}
      {noun}
      {detail ? ` · ${detail}` : ''}
    </Text>
  )
}
