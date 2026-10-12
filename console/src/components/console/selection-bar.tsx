// What you can do with the rows you ticked, in the place of the query line.
// A selection is a mode, and while it is on, the line under it is the thing
// least worth reading — so the bar lies over it (`ToolbarRow`'s `overlay`),
// at its height, and the rows below do not move: a shift-click aimed at the
// next row still lands on it. Everything about the selection is here — the
// count, "every match, not only the loaded ones", the bulk actions — instead
// of spread between the toolbar and the footer.

import { Button } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import type { Total } from '@/api/generated/Total'
import { formatNumber } from '@/lib/format'

export function SelectionBar({
  count,
  total,
  everything,
  filtered,
  noun,
  detail,
  onSelectEverything,
  onClear,
  actions,
  testId = 'selection-bar',
}: {
  /** How many are selected: the ticked rows, or every match when `everything`. */
  count: number
  /** How many the list's filter matches. */
  total?: Total | undefined
  /** Every match is selected, not only the ticked rows. */
  everything: boolean
  /** A filter is in force: "Select all 240 matching", since the bar covers the line that shows it. */
  filtered: boolean
  noun: { one: string; other: string }
  /** After the count: "12.4 MB". */
  detail?: string | undefined
  onSelectEverything?: (() => void) | undefined
  onClear: () => void
  /** Copy, Export, and the destructive action last (`ml-auto` puts it at the right end). */
  actions: ReactNode
  testId?: string
}) {
  const more =
    !everything && onSelectEverything !== undefined && total !== undefined && total.count > count
  return (
    <div
      className="absolute inset-0 z-10 flex items-center gap-2 overflow-x-auto border-b border-kumo-line bg-kumo-base px-3 whitespace-nowrap"
      role="toolbar"
      aria-label={`Selected ${noun.other}`}
      data-testid={testId}
    >
      <span className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<XIcon />}
          onClick={onClear}
          aria-label="Clear the selection"
          data-testid="clear-selection"
        />
        <span className="text-[13px] text-kumo-default" data-testid="selection-count">
          {everything ? 'All ' : ''}
          <span className="font-mono tabular-nums">{formatNumber(count)}</span> selected
        </span>
        {detail && (
          <span className="pl-1 font-mono text-[12px] text-kumo-subtle tabular-nums">
            · {detail}
          </span>
        )}
      </span>
      {/* Every match, not only the loaded rows. Named with what it reaches,
          because a filter is easy to forget while the line that shows it is
          covered by this bar. */}
      {more && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onSelectEverything}
          data-testid="select-everything"
        >
          Select all {formatNumber(total.count)}
          {total.exact ? '' : '+'}
          {filtered ? ' matching' : ''}
        </Button>
      )}
      <span className="mx-1 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
      <div className="flex min-w-0 flex-1 items-center gap-2">{actions}</div>
    </div>
  )
}
