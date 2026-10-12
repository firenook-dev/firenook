// The decisions panel beside a rules editor: every decision the rules made,
// newest first, and one opened onto who asked and why. The shell is the
// same on every rules page — the filter row, the narrowing chips, the
// count, the virtualized list, the detail with its way back and its
// previous and next — and an adapter fills it: Firestore's reads the
// official Requests WebSocket and narrows in the browser (that feed cannot
// be asked to), Storage's reads the `storage.decisions` topic, whose
// parameters the engine evaluates.
//
// - the feed speaks only when something is wrong with it (the adapter's
//   `notice`);
// - an empty list says what appears here and what never does (the
//   adapter's `empty`);
// - narrowing comes from the URL, so a denied read elsewhere links straight
//   to the decision behind it, and `pick` opens the newest matching denial
//   once — going back to the list afterwards is going back to the list;
// - a feed that lost decisions (a tab away longer than the engine keeps
//   them) says so in the list, where they are missing (`gaps`).

import { Button, Text } from '@cloudflare/kumo'
import { ArrowLeftIcon, CaretLeftIcon, CaretRightIcon, XIcon } from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, useEffect, useRef } from 'react'
import { useNow } from '@/lib/clock'

/** A list row's height: two lines of text. */
export const DECISION_ROW = 44

/** One narrowing the list is under, shown as a chip that takes it away. */
export interface DecisionNarrowing {
  label: string
  value: string
  onRemove: () => void
}

export function DecisionsShell<T>({
  items,
  itemKey,
  isDenied,
  selected,
  onOpen,
  onStep,
  pick,
  onPick,
  filters,
  narrowed,
  notice,
  empty,
  renderRow,
  renderDetail,
  footer,
  gaps,
  renderGap,
  clock = 'minute',
}: {
  /** The decisions to list, newest first, already narrowed. */
  items: readonly T[]
  itemKey: (item: T) => string
  isDenied: (item: T) => boolean
  selected: T | undefined
  /** Open a decision, or go back to the list (`undefined`): a step in history. */
  onOpen: (item: T | undefined) => void
  /** Step to the next newer or older decision in place. */
  onStep: (item: T) => void
  /** Open the newest denial the list holds, once. */
  pick?: boolean | undefined
  onPick: (item: T) => void
  /** The filter row: a text field or a folder, a user, denials only, a method. */
  filters: ReactNode
  narrowed: readonly DecisionNarrowing[]
  /** At the count line's right end: what is wrong with the feed, when something is. */
  notice?: ReactNode
  /** What an empty list says. */
  empty: string
  /** A row's two lines, inside the row's button. */
  renderRow: (item: T, now: number) => ReactNode
  renderDetail: (item: T) => ReactNode
  /** Under the list: the window the feed holds. */
  footer?: ReactNode
  /** Decisions the feed missed, keyed by the decision just older than each gap; the count when known. */
  gaps?: ReadonlyMap<string, number | null> | undefined
  /** A gap's line in the list. */
  renderGap?: ((missed: number | null) => ReactNode) | undefined
  /** How often relative times move. */
  clock?: 'second' | 'minute'
}) {
  // The console's shared clock, so "just now" does not stay just now.
  const now = useNow(clock)
  const denied = items.filter(isDenied).length

  useEffect(() => {
    if (!pick) return
    const match = items.find(isDenied)
    if (match) onPick(match)
  }, [pick, items, isDenied, onPick])

  if (selected) {
    const key = itemKey(selected)
    const index = items.findIndex((item) => itemKey(item) === key)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-kumo-line px-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeftIcon />}
            onClick={() => onOpen(undefined)}
            data-testid="decision-back"
          >
            All decisions
          </Button>
          <span className="ml-auto flex items-center gap-0.5">
            <Text as="span" variant="secondary" size="xs">
              {index >= 0 ? `${index + 1} of ${items.length}` : ''}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CaretLeftIcon />}
              aria-label="Newer decision"
              disabled={index <= 0}
              onClick={() => {
                const next = items[index - 1]
                if (next) onStep(next)
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CaretRightIcon />}
              aria-label="Older decision"
              disabled={index < 0 || index >= items.length - 1}
              onClick={() => {
                const next = items[index + 1]
                if (next) onStep(next)
              }}
            />
          </span>
        </div>
        {renderDetail(selected)}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="decisions">
      <div className="grid shrink-0 gap-2 border-b border-kumo-line px-3 py-2">
        <div className="flex items-center gap-2">{filters}</div>
        {narrowed.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="decisions-narrowed">
            {narrowed.map((narrowing) => (
              <NarrowChip key={narrowing.label} {...narrowing} />
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 text-[12px] text-kumo-subtle">
          <span data-testid="decisions-count">
            <span className="tabular-nums">{items.length}</span>{' '}
            {items.length === 1 ? 'decision' : 'decisions'}
            {denied > 0 && (
              <>
                {' '}
                · <span className="text-kumo-danger tabular-nums">{denied} denied</span>
              </>
            )}
          </span>
          {notice}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="p-4" data-testid="decisions-empty">
          <Text variant="secondary" size="sm">
            {empty}
          </Text>
        </div>
      ) : (
        <DecisionList
          items={items}
          itemKey={itemKey}
          now={now}
          onOpen={onOpen}
          renderRow={renderRow}
          gaps={gaps}
          renderGap={renderGap}
        />
      )}
      {footer}
    </div>
  )
}

/** A narrowing as a chip: what it narrows by, the value, and a way to take it off. */
export function NarrowChip({ label, value, onRemove }: DecisionNarrowing) {
  return (
    <span className="flex h-6 max-w-full items-center gap-1 rounded-md bg-kumo-tint pr-0.5 pl-2 text-[12px]">
      <span className="text-kumo-subtle">{label}</span>
      <span className="min-w-0 truncate font-mono">{value}</span>
      <Button
        variant="ghost"
        size="xs"
        shape="square"
        icon={<XIcon />}
        aria-label={`Stop narrowing by ${label.toLowerCase()}`}
        onClick={onRemove}
      />
    </span>
  )
}

type ListRow<T> = { kind: 'item'; item: T } | { kind: 'gap'; key: string; missed: number | null }

/** The list's rows: the decisions, with a gap's line above the decision just older than it. */
export function listRows<T>(
  items: readonly T[],
  itemKey: (item: T) => string,
  gaps: ReadonlyMap<string, number | null> | undefined,
): ListRow<T>[] {
  if (!gaps || gaps.size === 0) return items.map((item) => ({ kind: 'item', item }))
  const rows: ListRow<T>[] = []
  for (const item of items) {
    const key = itemKey(item)
    if (gaps.has(key)) rows.push({ kind: 'gap', key: `gap:${key}`, missed: gaps.get(key) ?? null })
    rows.push({ kind: 'item', item })
  }
  return rows
}

function DecisionList<T>({
  items,
  itemKey,
  now,
  onOpen,
  renderRow,
  gaps,
  renderGap,
}: {
  items: readonly T[]
  itemKey: (item: T) => string
  now: number
  onOpen: (item: T) => void
  renderRow: (item: T, now: number) => ReactNode
  gaps: ReadonlyMap<string, number | null> | undefined
  renderGap: ((missed: number | null) => ReactNode) | undefined
}) {
  'use no memo'
  const scroller = useRef<HTMLDivElement>(null)
  const listed = listRows(items, itemKey, renderGap ? gaps : undefined)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const rows = useVirtualizer({
    count: listed.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => DECISION_ROW,
    overscan: 8,
    getItemKey: (index) => {
      const row = listed[index]
      return row === undefined ? index : row.kind === 'gap' ? row.key : itemKey(row.item)
    },
  })
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" data-testid="decision-list">
      <ul className="relative" style={{ height: rows.getTotalSize() }}>
        {rows.getVirtualItems().map((row) => {
          const entry = listed[row.index]
          if (entry === undefined) return null
          if (entry.kind === 'gap')
            return (
              <li
                key={row.key}
                className="absolute inset-x-0 flex items-center border-b border-kumo-hairline bg-kumo-tint px-3 text-[12px] text-kumo-subtle"
                style={{ top: row.start, height: DECISION_ROW }}
                data-testid="decision-gap"
              >
                {renderGap?.(entry.missed)}
              </li>
            )
          const item = entry.item
          return (
            <li
              key={row.key}
              className="absolute inset-x-0"
              style={{ top: row.start, height: DECISION_ROW }}
            >
              <button
                type="button"
                onClick={() => onOpen(item)}
                className="grid h-full w-full content-center gap-0.5 border-b border-kumo-hairline px-3 text-left hover:ink"
                data-testid="decision-row"
                data-decision-id={itemKey(item)}
              >
                {renderRow(item, now)}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
