// One row of the Logs feed, as `FeedList` draws it: the shared `LogLine`
// (time, level, the source chip, the message) with the Logs trail — the
// ×N of a repeated line, `+N lines`, the payload caret and the line's
// primary link, drawn only where this engine runs its section — or a
// marker line (a reload, a reset), or an edge at the top of the feed.
//
// Rows are memoized and fed the row, its flags and a ref of the page's
// actions, as the grid's rows are, so a frame of new lines renders the new
// rows alone. Hovering a row that belongs to an invocation lights the
// other rows of that invocation; a store selector compares the hovered
// invocation, so only those rows render again.

import { Button, Tooltip, cn } from '@cloudflare/kumo'
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { type ReactNode, type RefObject, memo } from 'react'
import type { EntityRef } from '@/api/generated/EntityRef'
import type { LogEntry } from '@/api/generated/observe/LogEntry'
import { CopyButton } from '@/components/console/copy-button'
import type { JsonPath } from '@/components/console/json-tree-model'
import { LogLine } from '@/components/console/log-line'
import { formatNumber } from '@/lib/format'
import { useLinkTo } from '@/lib/links'
import { isMarkerKind } from '@/observe/kinds'
import { type SourceToken, SourceChip, lineSource } from '@/observe/source-chip'
import type { Highlighter } from '../highlight'
import { clockText } from '../range'
import type { LogEdge, LogItem } from '../rows'
import { useLogsUi } from '../store'
import { Highlighted } from './highlighted'

/** What a row can ask of the page, through a ref so a row never renders for a new closure. */
export interface RowActions {
  /** The source chip was clicked: its filter item goes into `q`. */
  pickToken: (token: SourceToken) => void
  /** The payload caret, or → / ←. */
  toggleExpanded: (key: string) => void
  /** "Filter" on a payload value. */
  filterPayload: (path: JsonPath, value: unknown) => void
}

/** What the top of the feed says, decided by the page from the engine's facts. */
export interface EdgeFacts {
  /** The engine has let lines go: older ones are not kept. */
  evicted: boolean
  /** The `--debug-log` file every line is also in, when there is one. */
  debugLog: string | null | undefined
  /** The page has a filter or a window: "no older lines match". */
  narrowed: boolean
  /** When the view was cleared. */
  clearedAt: string | undefined
  /** When the engine started (the log's first line). */
  startedAt: string | undefined
  showCleared: () => void
}

/** A line's primary link and its words: why a denial happened, the document it is about. */
export function primaryRef(entry: LogEntry): { ref: EntityRef; label: string } | undefined {
  const refs = entry.refs ?? []
  const find = (kind: string) => refs.find((ref) => ref.kind === kind)
  if (entry.kind === 'rules.denied' || entry.kind === 'rules.denied.console') {
    const decision = find('firestore.decision')
    if (decision) return { ref: decision, label: 'See why' }
  }
  const document = find('firestore.document')
  if (document) return { ref: document, label: 'Open document' }
  const collection = find('firestore.collection')
  if (collection) return { ref: collection, label: 'Open collection' }
  const decision = find('storage.decision')
  if (decision && entry.kind?.startsWith('storage.denied'))
    return { ref: decision, label: 'See why' }
  const first = refs[0]
  return first ? { ref: first, label: 'Open' } : undefined
}

/** The primary link, only when the section it opens can show it. */
function PrimaryLink({ entry }: { entry: LogEntry }) {
  const primary = primaryRef(entry)
  const link = useLinkTo(primary?.ref)
  if (!primary || !link) return null
  return (
    <Link
      to={link.to as never}
      search={link.search as never}
      onClick={(event) => event.stopPropagation()}
      className="shrink-0 text-[12px] whitespace-nowrap text-kumo-link underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
      tabIndex={-1}
      data-testid="log-row-link"
    >
      {primary.label}
    </Link>
  )
}

/** A `function.start` line's method and path, or what caused it, as the quiet trail. */
function startTrail(entry: LogEntry): string | undefined {
  if (entry.kind !== 'function.start' || !entry.payload) return undefined
  const { method, path } = entry.payload as { method?: unknown; path?: unknown }
  if (typeof method === 'string' && typeof path === 'string') return `${method} ${path}`
  return undefined
}

function LogRowInner({
  item,
  wrap,
  expanded,
  highlight,
  actions,
  edges,
}: {
  item: LogItem
  wrap: boolean
  expanded: boolean
  highlight: Highlighter | undefined
  actions: RefObject<RowActions>
  edges: EdgeFacts
}) {
  if (item.kind === 'edge') return <EdgeRow edge={item.edge} facts={edges} />
  const { entry } = item
  if (isMarkerKind(entry.kind)) return <MarkerLine entry={entry} highlight={highlight} />
  return (
    <LineRow
      entry={entry}
      itemKey={item.key}
      repeat={item.repeat}
      wrap={wrap}
      expanded={expanded}
      highlight={highlight}
      actions={actions}
    />
  )
}

export const LogRow = memo(LogRowInner)

function LineRow({
  entry,
  itemKey,
  repeat,
  wrap,
  expanded,
  highlight,
  actions,
}: {
  entry: LogEntry
  itemKey: string
  repeat: number
  wrap: boolean
  expanded: boolean
  highlight: Highlighter | undefined
  actions: RefObject<RowActions>
}) {
  const execution = entry.execution
  // Only the rows of the hovered invocation render again as it changes.
  const lit = useLogsUi((state) => execution !== undefined && state.hoveredExecution === execution)
  const hover = useLogsUi((state) => state.hover)
  const source = lineSource(entry)
  const trail = startTrail(entry)
  const hasMore = entry.payload !== undefined || (!wrap && entry.message.includes('\n'))
  const mark = highlight
    ? (text: string) => <Highlighted text={text} highlight={highlight} />
    : undefined
  return (
    <LogLine
      className={cn('w-full min-w-0 hover:bg-none', lit && 'bg-kumo-tint')}
      time={entry.time}
      level={entry.level}
      source={
        <SourceChip
          source={source}
          onPick={(token) => actions.current.pickToken(token)}
          tabIndex={-1}
          testId="log-row-source"
        />
      }
      message={entry.message}
      repeat={repeat}
      wrap={wrap}
      highlight={mark}
      trail={
        <>
          {trail && (
            // Bounded, so a long path never takes the message's room; the
            // inspector shows it whole.
            <span
              className="max-w-[24ch] truncate font-mono text-[11px] text-kumo-subtle"
              title={trail}
              data-testid="log-row-request"
            >
              {trail}
            </span>
          )}
          {entry.truncated && (
            <Tooltip
              content="The engine cut this line to fit its bounds: 64 KiB of message, 16 KiB of payload."
              render={
                <span className="font-mono text-[11px] text-kumo-subtle" data-testid="log-row-cut">
                  cut
                </span>
              }
            />
          )}
          {hasMore && (
            <Tooltip
              content={expanded ? 'Collapse ←' : 'Expand →'}
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  icon={expanded ? <CaretDownIcon /> : <CaretRightIcon />}
                  aria-label={expanded ? 'Collapse the line' : 'Expand the line'}
                  aria-expanded={expanded}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation()
                    actions.current.toggleExpanded(itemKey)
                  }}
                  className="h-4.5 !px-1 font-mono text-[11px] !text-kumo-subtle hover:!text-kumo-default"
                  data-testid="log-row-expand"
                >
                  {entry.payload !== undefined ? '{}' : null}
                </Button>
              }
            />
          )}
          <PrimaryLink entry={entry} />
        </>
      }
      onMouseEnter={execution ? () => hover(execution) : undefined}
      onMouseLeave={execution ? () => hover(undefined) : undefined}
      data-testid="log-row"
      data-cursor={entry.cursor}
      data-kind={entry.kind}
    />
  )
}

/**
 * A marker line — Functions reloaded, rules applied, a reset — drawn as a
 * divider across the feed with its time, the way the feed's own markers
 * are: it is a moment, not output.
 */
function MarkerLine({ entry, highlight }: { entry: LogEntry; highlight: Highlighter | undefined }) {
  return (
    <MarkerShape testId="log-marker-line" kind={entry.kind}>
      <span className="truncate">
        {highlight ? <Highlighted text={entry.message} highlight={highlight} /> : entry.message}
      </span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums">
        {clockText(Date.parse(entry.time))}
      </span>
    </MarkerShape>
  )
}

/** A divider row: 12 px subtle words centred between two hairlines. */
export function MarkerShape({
  children,
  testId,
  kind,
}: {
  children: ReactNode
  testId: string
  kind?: string | undefined
}) {
  return (
    <div
      className="flex h-6 w-full min-w-0 items-center gap-3 px-3 text-[12px] text-kumo-subtle"
      data-testid={testId}
      data-kind={kind}
    >
      <span className="h-px min-w-6 flex-1 bg-kumo-hairline" aria-hidden />
      <span className="flex min-w-0 shrink items-center gap-1.5">{children}</span>
      <span className="h-px min-w-6 flex-1 bg-kumo-hairline" aria-hidden />
    </div>
  )
}

/** A marker of the feed's own (a gap, a restart, lines that arrived while paused). */
export function FeedMarker({
  text,
  action,
}: {
  text: string
  action?: { label: string; run: () => void } | undefined
}) {
  return (
    <MarkerShape testId="log-marker">
      <span className="truncate">{text}</span>
      {action && (
        <Button
          variant="ghost"
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            action.run()
          }}
          className="shrink-0 text-[12px] !text-kumo-link"
          data-testid="log-marker-action"
        >
          {action.label}
        </Button>
      )}
    </MarkerShape>
  )
}

/** The top of the feed: where the log begins, where loading stopped, where the view was cleared. */
function EdgeRow({ edge, facts }: { edge: LogEdge; facts: EdgeFacts }) {
  if (edge === 'cap')
    return (
      <MarkerShape testId="log-edge" kind="cap">
        <span className="truncate">
          {formatNumber(20_000)} lines loaded · narrow the filter or pick a time range
        </span>
      </MarkerShape>
    )
  if (edge === 'cleared')
    return (
      <MarkerShape testId="log-edge" kind="cleared">
        <span className="truncate">
          View cleared
          {facts.clearedAt ? ` at ${clockText(Date.parse(facts.clearedAt))}` : ''}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            facts.showCleared()
          }}
          className="shrink-0 text-[12px] !text-kumo-link"
          data-testid="log-edge-show-cleared"
        >
          Show cleared lines
        </Button>
      </MarkerShape>
    )
  if (facts.evicted)
    return (
      <MarkerShape testId="log-edge" kind="evicted">
        <span className="truncate">
          The engine no longer keeps older lines; it keeps the newest {formatNumber(20_000)}.
        </span>
        {facts.debugLog && (
          <span className="flex min-w-0 items-center gap-1">
            <span className="shrink-0">Every line is also in</span>
            <span className="truncate font-mono text-[11px] text-kumo-default">
              {facts.debugLog}
            </span>
            <CopyButton value={facts.debugLog} label="Copy the path" size="xs" />
          </span>
        )}
      </MarkerShape>
    )
  return (
    <MarkerShape testId="log-edge" kind="start">
      <span className="truncate">
        {facts.narrowed
          ? 'No older lines match'
          : `The engine's log begins here${
              facts.startedAt ? ` · started ${clockText(Date.parse(facts.startedAt))}` : ''
            }`}
      </span>
    </MarkerShape>
  )
}
