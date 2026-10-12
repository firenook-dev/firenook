// A table's status bar: what is loaded on the left, with its one remedy
// beside it, and what to do with the list at the right end. There is no
// "Load more": the next page is fetched while the last rows are still ahead,
// so a button only ever arrived after the rows it would have loaded — "more
// on scroll" is said, not offered. And no "first page in N ms": it timed one
// request and was the browser's wall time read as the engine's speed.

import { Button, Text } from '@cloudflare/kumo'
import type { ReactNode } from 'react'
import type { Total } from '@/api/generated/Total'
import { formatNumber } from '@/lib/format'

/** The words on the left: "240 loaded · more on scroll", or the window's place in the list. */
export function footerText(options: {
  loaded: number
  rowOffset?: number | undefined
  total?: Total | undefined
  hasMore: boolean
}): string {
  const { loaded, rowOffset = 0, total, hasMore } = options
  const more = hasMore ? ' · more on scroll' : ''
  if (rowOffset > 0 && loaded > 0) {
    // The window slid: say where it is in the whole list.
    const of =
      total === undefined ? '' : ` of ${formatNumber(total.count)}${total.exact ? '' : '+'}`
    return `rows ${formatNumber(rowOffset + 1)}–${formatNumber(rowOffset + loaded)}${of}${more}`
  }
  return `${formatNumber(loaded)} loaded${more}`
}

export function TableFooter({
  loaded,
  rowOffset,
  total,
  hasMore,
  hiddenColumns = 0,
  onShowAll,
  noun,
  actions,
  testId = 'table-footer',
}: {
  loaded: number
  /** Rows before the first loaded one, once the window has slid. */
  rowOffset?: number | undefined
  total?: Total | undefined
  hasMore: boolean
  hiddenColumns?: number
  onShowAll?: (() => void) | undefined
  /** What a row is, for the accessible name: `{ one: 'user', other: 'users' }`. */
  noun: { one: string; other: string }
  /** At the right end: Export. */
  actions?: ReactNode
  testId?: string
}) {
  return (
    // Nothing here wraps: the bar is one row high, so a narrow table scrolls
    // its footer sideways instead of stacking the words.
    <div
      className="flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-t border-kumo-line px-3 whitespace-nowrap"
      role="status"
      aria-label={`Loaded ${noun.other}`}
      data-testid={testId}
    >
      <span className="shrink-0 tabular-nums" data-testid={`${testId}-text`}>
        <Text variant="secondary" size="sm" as="span">
          {footerText({ loaded, rowOffset, total, hasMore })}
        </Text>
      </span>
      {hiddenColumns > 0 && onShowAll && (
        <span className="shrink-0">
          <Button variant="ghost" size="xs" onClick={onShowAll} data-testid="show-all-columns">
            {hiddenColumns} hidden column{hiddenColumns === 1 ? '' : 's'} · show all
          </Button>
        </span>
      )}
      {actions && <span className="ml-auto flex shrink-0 items-center gap-1">{actions}</span>}
    </div>
  )
}
