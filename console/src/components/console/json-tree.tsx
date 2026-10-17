// A JSON value as a tree you can read, fold, search and copy from: event
// payloads, claims, metadata, message attributes, task bodies, log JSON.
//
// Every row is a line of the data face at 12 px, coloured with the code
// inks (`theme.css`): keys blue, strings green, everything that is not a
// string violet, punctuation grey — on a line of JSON the ink is the only
// thing saying whether `269` is a number or a string. A shut container says
// what it holds (`{ admin, plan, +3 }`, `[3 items]`); a long string is cut
// with how much more there is and "Show all", never silently; a container
// of thousands shows a page and "Show more". Search hits sit on a neutral
// ground (`bg-kumo-fill`), never amber, which means "warn" in a log and a
// mixed type in the grid.
//
// Pointing at a row brings up its strip — copy the path as JavaScript
// writes it, copy the value, and where the page can narrow its list to a
// value (Logs' `payload.<path>:<value>`), filter by it — floating over the
// end of the line rather than reserving it. Masked values (`mask`) are hidden until asked for, never
// searched, and copied only once shown; references to things another
// section shows (`refs`) are links into it.
//
// Virtualized: a payload of 50,000 values is the rows on screen.

import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { EntityRef } from '@/api/generated/EntityRef'
import { copyToClipboard } from '@/lib/copy'
import { formatNumber } from '@/lib/format'
import { describeKey, isMac } from '@/lib/shortcuts'
import { EntityLink } from './entity-link'
import {
  CUT_AT,
  type JsonPath,
  type JsonRow,
  PAGE,
  copyText,
  flatten,
  formatPath,
  leafText,
  matchRanges,
  pathKey,
  preview,
  search as searchJson,
  valueAt,
} from './json-tree-model'
import { MaskedValue } from './masked-value'
import { CopyStripButton, StripButton } from './strip-button'

/** One line of the tree: the code editor's own line height. */
export const TREE_ROW = 20
/** How far each level indents, px. */
const INDENT = 16
/** The row's own inset before the first level, px. */
const INSET = 8
/** How tall a tree with no height of its own grows before it scrolls. */
const AUTO_MAX = 480

const PUNCTUATION = 'text-(--color-firenook-code-punctuation)'
const KEY = 'font-medium text-(--color-firenook-code-key)'
const STRING = 'text-(--color-firenook-code-string)'
const LITERAL = 'text-(--color-firenook-code-literal)'

/** The strip: hidden and unclickable until its row is pointed at, its own focus shows it too. */
const STRIP =
  'pointer-events-none absolute top-0 right-1 flex items-center gap-1 rounded-md bg-kumo-base px-0.5 opacity-0 shadow-sm ring ring-kumo-line group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100'

export interface JsonTreeProps {
  value: unknown
  /** A row for the value itself, labelled so (`data`), which also leads every copied path. */
  rootLabel?: string | undefined
  /** Containers open by default down to this level; 1 opens the value and shuts what is in it. */
  defaultDepth?: number | undefined
  /** Text to find in keys and values; the containers around each hit open. */
  search?: string | undefined
  /** Which hit is current (an index into the hits), scrolled to and marked. */
  activeHit?: number | undefined
  /** How many hits the search found, and whether it stopped counting early. */
  onHits?: ((count: number, stopped: boolean) => void) | undefined
  /** `'fill'` flexes in a flex column; a number is the most it grows to before scrolling. */
  height?: number | 'fill' | undefined
  /** Values shown masked — `•••• (N characters)` with a reveal button: hashes, salts, refresh tokens. */
  mask?: ((path: JsonPath) => boolean) | undefined
  /** Values that are references another section shows, drawn as links into it. */
  refs?: ((path: JsonPath, value: unknown) => EntityRef | undefined) | undefined
  /**
   * A leaf's strip offers "filter": the page narrows its list to what holds
   * this value at this path (Logs adds `payload.<path>:<value>` to its
   * filter, the Google UI's click-to-filter). Never offered on a masked value.
   */
  onFilter?: ((path: JsonPath, value: unknown) => void) | undefined
  ariaLabel: string
  testId?: string | undefined
}

export function JsonTree({
  value,
  rootLabel,
  defaultDepth = 1,
  search = '',
  activeHit,
  onHits,
  height,
  mask,
  refs,
  onFilter,
  ariaLabel,
  testId,
}: JsonTreeProps) {
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set())
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())

  const found = useMemo(() => searchJson(value, search, mask), [value, search, mask])
  // A new search opens what it found, even where the person had shut it.
  const [searched, setSearched] = useState(search)
  if (searched !== search) {
    setSearched(search)
    if (found.open.size > 0)
      setToggled((current) => {
        const next = new Map(current)
        for (const key of found.open) if (next.get(key) === false) next.delete(key)
        return next
      })
  }

  const rows = useMemo(() => {
    const extra = new Map(shown)
    for (const [key, need] of found.shown) extra.set(key, Math.max(extra.get(key) ?? 0, need))
    return flatten(value, {
      rootLabel,
      defaultDepth,
      toggled,
      searchOpen: found.open,
      shown: extra,
    })
  }, [value, rootLabel, defaultDepth, toggled, found, shown])

  const hitKeys = useMemo(() => new Set(found.hits.map((hit) => hit.key)), [found])
  const activeKey = activeHit === undefined ? undefined : found.hits[activeHit]?.key
  const activeRow = activeKey === undefined ? -1 : rows.findIndex((row) => row.id === activeKey)

  const report = useRef(onHits)
  useEffect(() => {
    report.current = onHits
  })
  useEffect(() => {
    report.current?.(found.hits.length, found.stopped)
  }, [found])

  const toggle = (row: Extract<JsonRow, { kind: 'node' }>, open = !row.open) =>
    setToggled((current) => new Map(current).set(row.id, open))
  const showMore = (row: Extract<JsonRow, { kind: 'more' }>, all = false) =>
    setShown((current) =>
      new Map(current).set(pathKey(row.path), all ? row.total : row.shown + PAGE),
    )

  return (
    <TreeRows
      rows={rows}
      rootLabel={rootLabel}
      search={search}
      hitKeys={hitKeys}
      activeRow={activeRow}
      height={height}
      mask={mask}
      refs={refs}
      onFilter={onFilter}
      whole={whole}
      revealed={revealed}
      onToggle={toggle}
      onMore={showMore}
      onWhole={(key) => setWhole((current) => flip(current, key))}
      onReveal={(key, open) =>
        setRevealed((current) => (current.has(key) === open ? current : flip(current, key)))
      }
      valueOf={(path) => valueAt(value, path)}
      ariaLabel={ariaLabel}
      testId={testId}
    />
  )
}

/** The set with `key` in it if it was not, and out of it if it was. */
function flip(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

type NodeRow = Extract<JsonRow, { kind: 'node' }>
type MoreRow = Extract<JsonRow, { kind: 'more' }>

function TreeRows({
  rows,
  rootLabel,
  search,
  hitKeys,
  activeRow,
  height,
  mask,
  refs,
  onFilter,
  whole,
  revealed,
  onToggle,
  onMore,
  onWhole,
  onReveal,
  valueOf,
  ariaLabel,
  testId,
}: {
  rows: JsonRow[]
  rootLabel: string | undefined
  search: string
  hitKeys: ReadonlySet<string>
  activeRow: number
  height: number | 'fill' | undefined
  mask: ((path: JsonPath) => boolean) | undefined
  refs: ((path: JsonPath, value: unknown) => EntityRef | undefined) | undefined
  onFilter: ((path: JsonPath, value: unknown) => void) | undefined
  whole: ReadonlySet<string>
  revealed: ReadonlySet<string>
  onToggle: (row: NodeRow, open?: boolean) => void
  onMore: (row: MoreRow, all?: boolean) => void
  onWhole: (key: string) => void
  onReveal: (key: string, open: boolean) => void
  valueOf: (path: JsonPath) => unknown
  ariaLabel: string
  testId: string | undefined
}) {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const scroller = useRef<HTMLDivElement>(null)
  const id = useId()
  const [cursor, setCursor] = useState<string | undefined>()
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => TREE_ROW,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 12,
  })

  useEffect(() => {
    if (activeRow >= 0) virtualizer.scrollToIndex(activeRow, { align: 'center' })
  }, [activeRow, virtualizer])

  // The cursor is a row id, so it survives rows opening above it; a row
  // that went away (its parent shut) hands the cursor to nothing.
  const cursorIndex = cursor === undefined ? -1 : rows.findIndex((row) => row.id === cursor)
  const moveTo = (index: number) => {
    const row = rows[index]
    if (!row) return
    setCursor(row.id)
    virtualizer.scrollToIndex(index)
  }
  /** Rows the cursor stops on: a closing bracket is punctuation, not a place. */
  const step = (from: number, by: 1 | -1) => {
    let index = from + by
    while (rows[index]?.kind === 'close') index += by
    return rows[index] ? index : from
  }

  const masked = (row: NodeRow) => row.container === null && mask?.(row.path) === true
  const copyValue = (row: NodeRow) =>
    masked(row) && !revealed.has(row.id) ? undefined : copyText(valueOf(row.path))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const at = cursorIndex === -1 ? step(-1, 1) : cursorIndex
    const row = rows[at]
    const mod = isMac() ? event.metaKey : event.ctrlKey
    let handled = true
    if (event.key === 'ArrowDown') moveTo(cursorIndex === -1 ? at : step(at, 1))
    else if (event.key === 'ArrowUp') moveTo(cursorIndex === -1 ? at : step(at, -1))
    else if (event.key === 'Home') moveTo(step(-1, 1))
    else if (event.key === 'End') moveTo(step(rows.length, -1))
    else if (event.key === 'ArrowRight' && row?.kind === 'node' && row.container && row.size > 0) {
      if (!row.open) onToggle(row, true)
      else moveTo(step(at, 1))
    } else if (event.key === 'ArrowLeft' && row) {
      if (row.kind === 'node' && row.open) onToggle(row, false)
      else {
        const parent = pathKey(row.kind === 'more' ? row.path : row.path.slice(0, -1))
        const index = rows.findIndex((item) => item.kind === 'node' && item.id === parent)
        if (index !== -1) moveTo(index)
      }
    } else if ((event.key === 'Enter' || event.key === ' ') && row) {
      if (row.kind === 'node' && row.container && row.size > 0) onToggle(row)
      else if (row.kind === 'more') onMore(row)
      else if (row.kind === 'node' && typeof valueOf(row.path) === 'string') onWhole(row.id)
      else handled = false
    } else if (mod && !event.altKey && event.key.toLowerCase() === 'c' && row) {
      // ⌘C copies the cursor's value and ⇧⌘C its path, unless text is
      // selected: then the browser's own copy is what was asked for.
      const selected = window.getSelection()?.toString() ?? ''
      const text =
        row.kind !== 'node'
          ? undefined
          : event.shiftKey
            ? formatPath(row.path, rootLabel) || undefined
            : copyValue(row)
      if (selected !== '' || text === undefined) handled = false
      else void copyToClipboard(text)
    } else handled = false
    if (!handled) return
    event.preventDefault()
    // The tree's own keys: the page's shortcuts never see them.
    event.stopPropagation()
  }

  const total = virtualizer.getTotalSize()
  const box = height === 'fill' ? 'min-h-0 flex-1' : ''
  const pixels = height === 'fill' ? undefined : Math.min(total, height ?? AUTO_MAX)
  const cursorRow = cursorIndex === -1 ? undefined : rows[cursorIndex]

  return (
    <div
      ref={scroller}
      role="tree"
      aria-label={ariaLabel}
      aria-activedescendant={cursorRow ? `${id}-${cursorIndex}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        // A Tab into the tree lands on its first row; a click lands on the
        // row clicked, which its own mouse-down has already picked.
        if (
          event.target === event.currentTarget &&
          cursor === undefined &&
          event.currentTarget.matches(':focus-visible')
        )
          moveTo(step(-1, 1))
      }}
      className={`group/tree relative overflow-auto outline-none focus-visible:ring focus-visible:ring-kumo-focus focus-visible:ring-inset ${box}`}
      // The tree's measured height, capped: a value of three keys is three
      // rows tall, not a box of empty space.
      style={pixels === undefined ? undefined : { height: Math.max(pixels, TREE_ROW) }}
      data-testid={testId}
    >
      <div className="relative w-full" style={{ height: total }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute inset-x-0"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <Row
                row={row}
                elementId={`${id}-${item.index}`}
                cursor={row.id === cursor}
                active={item.index === activeRow}
                rootLabel={rootLabel}
                search={search}
                hit={hitKeys.has(row.id)}
                masked={row.kind === 'node' && masked(row)}
                revealed={revealed.has(row.id)}
                whole={whole.has(row.id)}
                entity={
                  row.kind === 'node' && row.container === null
                    ? refs?.(row.path, row.value)
                    : undefined
                }
                onToggle={onToggle}
                onMore={onMore}
                onWhole={onWhole}
                onReveal={onReveal}
                onPick={() => setCursor(row.id)}
                copyValue={row.kind === 'node' ? () => copyValue(row) : undefined}
                filter={
                  onFilter && row.kind === 'node' && row.container === null && !masked(row)
                    ? () => onFilter(row.path, valueOf(row.path))
                    : undefined
                }
                testId={testId}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** `text` with every occurrence of `search` on the neutral hit ground. */
function Marked({ text, search, on }: { text: string; search: string; on: boolean }) {
  if (!on) return <>{text}</>
  const ranges = matchRanges(text, search)
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from))
    parts.push(
      <mark key={from} className="rounded-[2px] bg-kumo-fill font-semibold text-inherit">
        {text.slice(from, to)}
      </mark>,
    )
    at = to
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

function Row({
  row,
  elementId,
  cursor,
  active,
  rootLabel,
  search,
  hit,
  masked,
  revealed,
  whole,
  entity,
  onToggle,
  onMore,
  onWhole,
  onReveal,
  onPick,
  copyValue,
  filter,
  testId,
}: {
  row: JsonRow
  elementId: string
  cursor: boolean
  active: boolean
  rootLabel: string | undefined
  search: string
  hit: boolean
  masked: boolean
  revealed: boolean
  whole: boolean
  entity: EntityRef | undefined
  onToggle: (row: NodeRow, open?: boolean) => void
  onMore: (row: MoreRow, all?: boolean) => void
  onWhole: (key: string) => void
  onReveal: (key: string, open: boolean) => void
  onPick: () => void
  copyValue: (() => string | undefined) | undefined
  /** The page's "filter by this value", for a leaf it can filter on. */
  filter: (() => void) | undefined
  testId: string | undefined
}) {
  const indent = INSET + row.depth * INDENT
  const guides: ReactNode[] = []
  for (let level = 0; level < row.depth; level += 1)
    guides.push(
      <span
        key={level}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-px bg-kumo-hairline"
        style={{ left: INSET + level * INDENT + 7 }}
      />,
    )
  const line = `group/row relative flex min-h-5 items-start pr-2 font-mono text-[12px] leading-5 ${
    cursor
      ? 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-firenook-flame)]'
      : active
        ? 'bg-kumo-tint'
        : 'hover:ink'
  }`

  if (row.kind === 'close')
    return (
      <div className={line} style={{ paddingLeft: indent }} aria-hidden>
        {guides}
        <span className="w-4 shrink-0" />
        <span className={PUNCTUATION}>{row.bracket}</span>
      </div>
    )

  if (row.kind === 'more') {
    const left = row.total - row.shown
    return (
      <div
        id={elementId}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={cursor}
        className={line}
        style={{ paddingLeft: indent }}
        data-testid={testId && `${testId}-more`}
      >
        {guides}
        <span className="w-4 shrink-0" />
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 font-sans text-[12px] text-kumo-subtle">
          <span>{formatNumber(left)} more not shown</span>
          <button
            type="button"
            tabIndex={-1}
            className="rounded-md px-1 text-kumo-link hover:ink"
            onClick={() => onMore(row)}
          >
            Show {formatNumber(Math.min(PAGE, left))} more
          </button>
          {left > PAGE && (
            <button
              type="button"
              tabIndex={-1}
              className="rounded-md px-1 text-kumo-link hover:ink"
              onClick={() => onMore(row, true)}
            >
              Show all
            </button>
          )}
        </span>
      </div>
    )
  }

  const value = row.value
  const toggleable = row.container !== null && row.size > 0
  const path = formatPath(row.path, rootLabel)
  return (
    <div
      id={elementId}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={toggleable ? row.open : undefined}
      aria-selected={cursor}
      className={line}
      style={{ paddingLeft: indent }}
      onMouseDown={onPick}
      data-testid={testId && `${testId}-row`}
      data-path={path}
    >
      {guides}
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        {toggleable && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="flex h-4 w-4 items-center justify-center rounded-sm text-kumo-subtle hover:ink hover:text-kumo-default"
            onClick={() => onToggle(row)}
            data-testid={testId && `${testId}-caret`}
          >
            {row.open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
          </button>
        )}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {row.label !== undefined &&
          (typeof row.label === 'number' ? (
            <span className={PUNCTUATION}>{row.label}: </span>
          ) : (
            <>
              <span className={KEY}>
                <Marked text={row.label} search={search} on={hit} />
              </span>
              <span className={PUNCTUATION}>: </span>
            </>
          ))}
        {row.container !== null ? (
          row.open ? (
            <span className={PUNCTUATION}>{row.container === 'array' ? '[' : '{'}</span>
          ) : (
            // What it holds is also the way in: the words beside a caret
            // are what the eye goes to, and the caret is eleven pixels.
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              disabled={!toggleable}
              className={`rounded-sm text-left ${PUNCTUATION} ${toggleable ? 'hover:underline' : ''}`}
              onClick={() => onToggle(row, true)}
            >
              {preview(value)}
            </button>
          )
        ) : masked ? (
          <MaskedValue
            value={leafText(value)}
            label="Show the value"
            revealed={revealed}
            onRevealedChange={(open) => onReveal(row.id, open)}
            testId={testId && `${testId}-masked`}
          />
        ) : entity ? (
          <>
            {typeof value === 'string' && <span className={PUNCTUATION}>"</span>}
            <EntityLink entity={{ ...entity, label: entity.label ?? leafText(value) }} />
            {typeof value === 'string' && <span className={PUNCTUATION}>"</span>}
          </>
        ) : (
          <Leaf
            value={value}
            search={search}
            hit={hit}
            whole={whole}
            onWhole={() => onWhole(row.id)}
          />
        )}
      </span>
      {copyValue && (
        <span className={STRIP}>
          {path !== '' && (
            <CopyStripButton
              value={path}
              label={`Copy the path ${path}`}
              title={`Copy the path · ${describeKey('Mod+Shift+c')}`}
              tabIndex={-1}
              testId={testId && `${testId}-copy-path`}
            >
              path
            </CopyStripButton>
          )}
          {(!masked || revealed) && (
            <CopyStripButton
              value={() => copyValue() ?? ''}
              label="Copy the value"
              title={`Copy the value · ${describeKey('Mod+c')}`}
              tabIndex={-1}
              testId={testId && `${testId}-copy-value`}
            >
              value
            </CopyStripButton>
          )}
          {filter && (
            <StripButton
              label={`Filter by ${path || 'this value'}`}
              title="Show only what holds this value here"
              tabIndex={-1}
              onClick={filter}
              testId={testId && `${testId}-filter`}
            >
              filter
            </StripButton>
          )}
        </span>
      )}
    </div>
  )
}

function Leaf({
  value,
  search,
  hit,
  whole,
  onWhole,
}: {
  value: unknown
  search: string
  hit: boolean
  whole: boolean
  onWhole: () => void
}) {
  if (typeof value === 'string') {
    const cut = !whole && value.length > CUT_AT
    const text = cut ? value.slice(0, CUT_AT) : value
    return (
      <>
        <span className={STRING}>
          "<Marked text={text} search={search} on={hit} />
          {cut ? '…' : '"'}
        </span>
        {value.length > CUT_AT && (
          <span className="font-sans text-[11px] text-kumo-subtle">
            {cut && ` ${formatNumber(value.length - CUT_AT)} more characters ·`}{' '}
            <button
              type="button"
              tabIndex={-1}
              className="rounded-sm text-kumo-link hover:underline"
              onClick={onWhole}
            >
              {cut ? 'Show all' : 'Show less'}
            </button>
          </span>
        )}
      </>
    )
  }
  const text = leafText(value)
  const tone =
    value === null
      ? `${LITERAL} italic opacity-75`
      : typeof value === 'boolean'
        ? `${LITERAL} font-medium`
        : LITERAL
  return (
    <span className={tone}>
      <Marked text={text} search={search} on={hit} />
    </span>
  )
}
