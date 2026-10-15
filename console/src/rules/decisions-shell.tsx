// The decisions panel beside a rules editor: every decision the rules made,
// newest first, and one opened onto who asked and why. The panel is one
// design on every rules page — the filter row (one field for path, user and
// method terms, All or Denied, Clear), the narrowing chips, the count, the
// virtualized list of two-line rows, the footer that says what is held,
// the detail with its way back and its previous and next — and the kit's
// decisions panel (`decisions-panel.tsx`) fills it from a page's decision
// log: Firestore's `firestore.decisions` topic or Storage's
// `storage.decisions`, whose parameters the engine evaluates.
//
// A row reads the same on both pages: the verdict, the method, the path;
// then when, who, what else the page knows (an upload's size and type),
// what the draft would make of it, and the lines that decided it.
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

import { Button, InputGroup, Tabs, Text, Tooltip } from '@cloudflare/kumo'
import {
  ArrowLeftIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, useEffect, useRef } from 'react'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import { ClearHistoryButton } from '@/components/console/clear-history-button'
import { useNow } from '@/lib/clock'
import { exactTime } from '@/components/console/relative-time'
import { relativeTime } from '@/lib/format'
import { Verdict } from './verdict'

/** A list row's height: two lines of text. */
export const DECISION_ROW = 44

/** What a row says, the same way on every rules page. */
export interface DecisionRowParts {
  outcome: RulesOutcome
  /** `get`, `create`, …: data, in the data face. */
  method: string
  path: string
  /** Cut a long path from its start, so a file's own name stays (Storage's). */
  keepEnd?: boolean | undefined
  /** When, RFC 3339: the row says how long ago, its tooltip the exact time. */
  at: string
  /** Who asked: a uid, `anonymous`, `not signed in`. */
  who: string
  /** What else the page knows, each in the data face: a bucket, an upload's size and type. */
  extras?: readonly string[] | undefined
  /** What applying the draft would make of it, when it would change it. */
  flip?: RulesOutcome | undefined
  /** The lines that decided it. */
  lines: readonly number[]
}

/** The filter field: path, user and method terms, as each page reads them. */
export interface DecisionFilter {
  value: string
  onChange: (value: string) => void
  /** Enter, or the field cleared: the page acts now rather than when typing settles. */
  onCommit?: ((value: string) => void) | undefined
  /** Says which terms it takes: "Filter by path, user or method". */
  placeholder: string
}

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
  filter,
  denied: deniedOnly,
  onDenied,
  onClearList,
  narrowed,
  notice,
  empty,
  row,
  renderDetail,
  held,
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
  filter: DecisionFilter
  /** Denials only. */
  denied: boolean
  onDenied: (denied: boolean) => void
  /** Forget the decisions this tab holds; absent: nothing to forget. */
  onClearList?: (() => void) | undefined
  narrowed: readonly DecisionNarrowing[]
  /** At the count line's right end: what is wrong with the feed, when something is. */
  notice?: ReactNode
  /** What an empty list says. */
  empty: string
  /** What a row says. */
  row: (item: T) => DecisionRowParts
  renderDetail: (item: T) => ReactNode
  /** Under the list: what the panel holds ("Holding the last 12 decisions, since 09:12:04 · …"). */
  held?: string | undefined
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
        <div className="flex min-w-0 items-center gap-2">
          <FilterField {...filter} />
          <Tabs
            variant="segmented"
            size="sm"
            value={deniedOnly ? 'denied' : 'all'}
            onValueChange={(next) => onDenied(next === 'denied')}
            tabs={[
              { value: 'all', label: 'All' },
              { value: 'denied', label: 'Denied' },
            ]}
          />
          {onClearList && (
            <Tooltip
              content="Clear the list in this tab"
              render={
                <span className="inline-flex shrink-0">
                  <ClearHistoryButton
                    label="Clear"
                    title="Clear the list"
                    onClick={onClearList}
                    disabled={items.length === 0 && narrowed.length === 0}
                    testId="decisions-clear-list"
                  />
                </span>
              }
            />
          )}
        </div>
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
          row={row}
          gaps={gaps}
          renderGap={renderGap}
        />
      )}
      {held && (
        <div
          className="shrink-0 border-t border-kumo-line px-3 py-1.5 text-[11px] text-kumo-subtle"
          data-testid="decisions-window"
        >
          {held}
        </div>
      )}
    </div>
  )
}

/** The one filter field: a magnifier, the terms, and × to clear them. */
function FilterField({ value, onChange, onCommit, placeholder }: DecisionFilter) {
  return (
    <InputGroup size="sm" className="min-w-0 flex-1">
      <InputGroup.Addon>
        <MagnifyingGlassIcon size={14} />
      </InputGroup.Addon>
      <InputGroup.Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onCommit?.(value)
          if (event.key === 'Escape' && value !== '') {
            event.preventDefault()
            onChange('')
            onCommit?.('')
          }
        }}
        placeholder={placeholder}
        aria-label="Filter decisions"
        spellCheck={false}
        autoComplete="off"
        className="font-mono placeholder:font-sans"
        data-testid="decisions-filter"
      />
      {value !== '' && (
        <InputGroup.Addon align="end">
          {/* No size: the group's sm makes it the compact xs, as the panel filter's. */}
          <InputGroup.Button
            variant="ghost"
            shape="square"
            icon={<XIcon />}
            aria-label="Clear the filter"
            onClick={() => {
              onChange('')
              onCommit?.('')
            }}
            data-testid="decisions-filter-clear"
          />
        </InputGroup.Addon>
      )}
    </InputGroup>
  )
}

/** A decision's two lines. */
function DecisionRow({ parts, now }: { parts: DecisionRowParts; now: number }) {
  const { lines } = parts
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex shrink-0 items-center">
          <Verdict outcome={parts.outcome} />
        </span>
        <span className="shrink-0 font-mono text-[12px] text-kumo-subtle">{parts.method}</span>
        {parts.keepEnd ? (
          <span
            className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-kumo-default"
            dir="rtl"
            title={parts.path}
          >
            <bdi>{parts.path || '/'}</bdi>
          </span>
        ) : (
          <span className="min-w-0 truncate font-mono text-[12px] text-kumo-default">
            {parts.path || '/'}
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-kumo-subtle">
        <span className="shrink-0 tabular-nums" title={exactTime(parts.at)}>
          {relativeTime(parts.at, now)}
        </span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate font-mono">{parts.who}</span>
        {(parts.extras ?? []).map((extra) => (
          <span key={extra} className="flex min-w-0 shrink items-center gap-1.5">
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate font-mono">{extra}</span>
          </span>
        ))}
        {parts.flip && (
          <span className="shrink-0 text-kumo-warning" data-testid="decision-flip">
            → {parts.flip === 'allow' ? 'allowed' : 'denied'} by the draft
          </span>
        )}
        {lines.length > 0 && (
          <span className="ml-auto shrink-0 font-mono">
            {lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(', ')}`}
          </span>
        )}
      </span>
    </>
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
  row: rowOf,
  gaps,
  renderGap,
}: {
  items: readonly T[]
  itemKey: (item: T) => string
  now: number
  onOpen: (item: T) => void
  row: (item: T) => DecisionRowParts
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
                <DecisionRow parts={rowOf(item)} now={now} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
