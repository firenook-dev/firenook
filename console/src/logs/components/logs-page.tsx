// The Logs page: every service's log in one stream, as a workbench. The
// section panel holds the facets; row one is the window in time (the range
// picker and the volume strip) with the view's menu; row two is the query
// (the filter field, how many lines match, pause); the body is the feed
// with the inspector beside it.
//
// The URL is the truth for the view (`q`, `from`, `to`, `entry`, `since`,
// `paused`); the engine for every count; the feed store (`feed.ts`) for
// the lines on screen. The page itself never reads the store while it
// renders: the pieces that draw from it (`FeedList`, the pause button, the
// inspector) subscribe on their own, so a frame of new lines renders them
// alone.

import { Button, Empty, Tooltip } from '@cloudflare/kumo'
import { ArrowDownIcon, FunnelIcon, ScrollIcon } from '@phosphor-icons/react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LogEntry } from '@/api/generated/observe/LogEntry'
import { statusQuery } from '@/api/queries'
import { EmptyState, QueryError, TableSkeleton } from '@/components/console/empty-state'
import { FeedFooter } from '@/components/console/feed-footer'
import { FeedList, useFeedPending } from '@/components/console/feed-list'
import { FilterField, type FilterRefusal } from '@/components/console/filter-field'
import type { JsonPath } from '@/components/console/json-tree-model'
import { LiveNotice } from '@/components/console/live-notice'
import { MatchCount } from '@/components/console/match-count'
import { PauseButton } from '@/components/console/pause-button'
import {
  type RowMenuAnchor,
  type RowMenuItem,
  RowMenuPopup,
  useRowMenuPalette,
} from '@/components/console/row-menu'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import { SectionToolbar, ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { PanelToggle } from '@/components/shell/section-panel'
import { copyToClipboard } from '@/lib/copy'
import { download } from '@/lib/download'
import { checkFilter } from '@/lib/filter'
import { formatNumber } from '@/lib/format'
import { linkTo } from '@/lib/links'
import { liveChannel } from '@/lib/live/channel'
import { type FeedStore, useFeed } from '@/lib/live/feed-store'
import { createInvalidator } from '@/lib/live/use-live-topic'
import { useConsoleProject } from '@/lib/project'
import { useRouteSearch } from '@/lib/search-params'
import { isProblemLine } from '@/observe/kinds'
import { bucketSentence, bucketSpan, bucketTotal, levelBuckets } from '@/observe/level-bars'
import { LevelStrip } from '@/observe/level-strip'
import { type SourceToken, sourceTokenText } from '@/observe/source-chip'
import { engineQuery } from '@/overview/api'
import {
  type LogsView,
  LogsRequestError,
  exportUrl,
  facetsQuery,
  histogramQuery,
  logsKeys,
} from '../api'
import { ENGINE_KEEPS, type FeedOpen, type LogFeed, useLogFeed } from '../feed'
import { LOGS_PLACEHOLDER, LOG_FIELDS, logFields } from '../fields'
import { entriesAsText, entryAsJson, entryAsText } from '../format'
import { highlighter } from '../highlight'
import { useLogsPalette } from '../palette'
import { type SavedFilter, useLogsPrefs, useSavedFilters } from '../prefs'
import { aroundWindow, bucketWindow } from '../range'
import { type LogItem, itemKey } from '../rows'
import type { LogsSearch } from '../search'
import { useLogsShortcuts } from '../shortcuts'
import { type ClearedAt, clearedKey, readCleared, useLogsUi, writeCleared } from '../store'
import {
  LEVEL_VIEWS,
  addTerm,
  executionTerm,
  flipLevelView,
  hideLikeTerm,
  payloadTerm,
  phraseTerm,
} from '../terms'
import { toggleFacet } from '@/components/console/facet-list'
import { FacetsPanel } from './facets-panel'
import { LogDetail } from './log-detail'
import { type InspectorActions, LogInspector } from './log-inspector'
import { LogMenu } from './log-menu'
import { type EdgeFacts, FeedMarker, LogRow, type RowActions, primaryRef } from './log-row'
import { NoLines } from './no-lines'
import { RangePicker } from './range-picker'

/** How long the filter waits after the last keystroke before it applies what parses. */
const TYPING_MS = 250

const LINE_NOUN = { one: 'line', other: 'lines' }

/** A line row of the feed store, by key; undefined for an edge, a marker or a key it does not hold. */
function lineAt(
  feed: LogFeed,
  key: string | undefined,
): Extract<LogItem, { kind: 'line' }> | undefined {
  if (key === undefined) return undefined
  const index = feed.store.indexOf(key)
  const row = index === -1 ? undefined : feed.store.at(index)
  return row?.kind === 'item' && row.item.kind === 'line' ? row.item : undefined
}

/** The line rows of the feed, oldest first. */
function lineRows(feed: LogFeed): Extract<LogItem, { kind: 'line' }>[] {
  const rows: Extract<LogItem, { kind: 'line' }>[] = []
  for (let index = 0; index < feed.store.size(); index += 1) {
    const row = feed.store.at(index)
    if (row?.kind === 'item' && row.item.kind === 'line') rows.push(row.item)
  }
  return rows
}

/** The next line row after (or before) `key` that `accept` takes. */
function stepLine(
  feed: LogFeed,
  key: string | undefined,
  step: 1 | -1,
  accept: (item: Extract<LogItem, { kind: 'line' }>) => boolean = () => true,
): Extract<LogItem, { kind: 'line' }> | undefined {
  const size = feed.store.size()
  const from = key === undefined ? -1 : feed.store.indexOf(key)
  let index = from === -1 ? (step === 1 ? -1 : size) : from
  for (index += step; index >= 0 && index < size; index += step) {
    const row = feed.store.at(index)
    if (row?.kind === 'item' && row.item.kind === 'line' && accept(row.item)) return row.item
  }
  return undefined
}

async function copy(text: string, title: string) {
  await copyToClipboard(text, { title })
}

export function LogsPage() {
  const { search, update } = useRouteSearch<LogsSearch>('/logs', '/logs')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { project } = useConsoleProject()
  const status = useQuery(statusQuery)
  const engine = useQuery({ ...engineQuery(project), enabled: project !== '' })
  const wrap = useLogsPrefs((state) => state.wrap)
  const keep = useLogsPrefs((state) => state.keepAcrossRestarts)
  const setWrap = useLogsPrefs((state) => state.setWrap)
  const setKeep = useLogsPrefs((state) => state.setKeepAcrossRestarts)
  const saveFilter = useLogsPrefs((state) => state.save)
  const forgetFilter = useLogsPrefs((state) => state.forget)
  const saved = useSavedFilters(project)
  const expanded = useLogsUi((state) => state.expanded)
  const toggleExpanded = useLogsUi((state) => state.toggleExpanded)

  const q = search.q ?? ''
  const view: LogsView = { q, from: search.from, to: search.to }
  const paused = search.paused === true
  const checked = checkFilter(q, { fields: LOG_FIELDS, regex: true })
  const ready = checked.ok && project !== ''
  const facets = useQuery({
    ...facetsQuery(project, view),
    enabled: ready,
    placeholderData: keepPreviousData,
  })
  const histogram = useQuery({
    ...histogramQuery(project, view),
    enabled: ready,
    placeholderData: keepPreviousData,
  })
  const fields = logFields(facets.data)
  const highlight = checked.ok ? highlighter(q) : undefined

  // A cleared view, for this tab, project and engine run.
  const instance = status.data?.instance
  const storage = project !== '' && instance ? clearedKey(project, instance) : undefined
  const [clearedState, setClearedState] = useState<{
    key: string | undefined
    value: ClearedAt | undefined
  }>(() => ({ key: storage, value: storage ? readCleared(storage) : undefined }))
  let cleared = clearedState.value
  if (clearedState.key !== storage) {
    cleared = storage ? readCleared(storage) : undefined
    setClearedState({ key: storage, value: cleared })
  }
  const setCleared = (value: ClearedAt | undefined) => {
    if (storage) writeCleared(storage, value)
    setClearedState({ key: storage, value })
  }

  // The line a link opened, for the open it asked for; the cursor row; a
  // row a key moved to (F8), put in view for the open it belongs to.
  const [openEntry, setOpenEntry] = useState(search.entry)
  const [cursor, setCursor] = useState<string | undefined>(search.entry)
  const [jump, setJump] = useState<{ key: string; generation: number } | undefined>(undefined)

  const request: FeedOpen | null = ready
    ? { view, entry: openEntry, since: search.since, cleared }
    : null
  const onLines = useRef(() => undefined as void)
  const { feed, state } = useLogFeed(request, paused, {
    channel: liveChannel,
    keepAcrossRestarts: () => useLogsPrefs.getState().keepAcrossRestarts,
    onLines: () => onLines.current(),
  })
  const linesLoaded = useLineCount(feed.store)

  // Counts follow the lines: marked stale as they arrive, refetched at most
  // once in 1.5 s (and once after the last), never counted here.
  const [invalidator] = useState(() =>
    createInvalidator((key) => void queryClient.invalidateQueries({ queryKey: key }), 1500),
  )
  useEffect(() => () => invalidator.dispose(), [invalidator])
  useLayoutEffect(() => {
    onLines.current = () =>
      invalidator.push([logsKeys.facets(project, view), logsKeys.histogram(project, view)])
  })

  // A line the URL comes to name (a link, Back) that the feed does not hold
  // opens the lines around it. Asked only when the URL's line changes: the
  // feed's own rows are always held, so selecting one never reopens.
  const [seenEntry, setSeenEntry] = useState(search.entry)
  if (search.entry !== seenEntry) {
    setSeenEntry(search.entry)
    const entry = search.entry
    if (entry !== undefined && entry !== openEntry && feed.store.indexOf(entry) === -1) {
      setOpenEntry(entry)
      setCursor(entry)
    }
  }

  // Where an open asked to be read from — the line in the middle, paused;
  // the "new since your last visit" marker at the top — once per open.
  const focusKey = state.focus?.key
  const focusPause = state.focus?.pause === true
  const mode = state.mode
  const generation = state.generation
  const [focusedOpen, setFocusedOpen] = useState(0)
  if (focusKey !== undefined && focusedOpen !== generation) {
    setFocusedOpen(generation)
    if (mode === 'around') setCursor(focusKey)
  }
  const focused = useRef(0)
  useEffect(() => {
    if (focusKey === undefined || focused.current === generation) return
    focused.current = generation
    if (mode === 'around') update({ entry: focusKey, paused: true }, { replace: true })
    else if (focusPause && !paused) update({ paused: true }, { replace: true })
  }, [focusKey, focusPause, mode, generation, paused, update])

  const setQ = (next: string, replace = false) =>
    update({ q: next.trim() === '' ? undefined : next }, { replace })
  const setWindow = (window: { from: string | undefined; to: string | undefined }) =>
    update({ from: window.from, to: window.to })
  const openLine = (key: string) => {
    setCursor(key)
    update({ entry: key, paused: true }, { replace: true })
  }
  const closeLine = () => update({ entry: undefined }, { replace: true })
  const backToLatest = () => {
    setOpenEntry(undefined)
    setCursor(undefined)
    update({ entry: undefined, paused: undefined }, { replace: true })
  }
  const onFollowChange = (follow: boolean) => {
    if (follow && state.mode === 'around') {
      backToLatest()
      return
    }
    update({ paused: follow ? undefined : true }, { replace: true })
  }

  // The filter applies what parses as the developer pauses typing, and
  // anything at all on Enter or when the field is left: an item still being
  // typed is not an error yet, and the rows stay until it is done.
  const typing = useRef<{
    text: string
    committed: string
    timer: ReturnType<typeof setTimeout> | undefined
  }>({ text: q, committed: q, timer: undefined })
  useEffect(() => () => clearTimeout(typing.current.timer), [])
  // A filter set from elsewhere (a facet, a chip, Back) is what is typed
  // now; the URL catching up with what was typed here changes nothing.
  useLayoutEffect(() => {
    if (q === typing.current.committed) return
    clearTimeout(typing.current.timer)
    typing.current = { text: q, committed: q, timer: undefined }
  }, [q])
  const commitTyped = () => {
    clearTimeout(typing.current.timer)
    typing.current.timer = undefined
    if (typing.current.text === typing.current.committed) return
    typing.current.committed = typing.current.text
    setQ(typing.current.text, true)
  }
  const onFilterChange = (text: string) => {
    typing.current.text = text
    clearTimeout(typing.current.timer)
    typing.current.timer = undefined
    if (checkFilter(text, { fields: LOG_FIELDS, regex: true }).ok)
      typing.current.timer = setTimeout(commitTyped, TYPING_MS)
  }

  // What the engine refused of a filter that parses here (a regex): the
  // field underlines it, and the list says it instead of rows.
  const refusedBy = facets.error instanceof LogsRequestError ? facets.error : undefined
  const refusal: FilterRefusal | undefined =
    refusedBy?.code === 'invalid-argument' && refusedBy.span
      ? { text: q, message: refusedBy.message, ...refusedBy.span }
      : undefined

  // Actions every row and the inspector reach through a ref.
  const pressed = useRef<{ key: string; at: number } | undefined>(undefined)
  const filterPayload = (path: JsonPath, value: unknown) =>
    setQ(addTerm(q, payloadTerm(path, value) ?? phraseTerm(value)))
  const rowActions = useRef<RowActions>({
    pickToken: () => undefined,
    toggleExpanded: () => undefined,
    filterPayload: () => undefined,
  })
  useLayoutEffect(() => {
    rowActions.current = {
      pickToken: (token: SourceToken) => setQ(addTerm(q, sourceTokenText(token))),
      toggleExpanded: (key) => toggleExpanded(key),
      filterPayload,
    }
  })

  const onSelect = (item: LogItem) => {
    if (item.kind !== 'line') return
    const press = pressed.current
    pressed.current = undefined
    const pointer = press !== undefined && press.key === item.key && Date.now() - press.at < 1000
    const current = cursor ?? search.entry
    if (item.key === current && !pointer) {
      // Enter on the cursor row opens or closes it.
      if (search.entry === item.key) closeLine()
      else openLine(item.key)
      return
    }
    setCursor(item.key)
    if (pointer || search.entry !== undefined) openLine(item.key)
    else if (!paused) update({ paused: true }, { replace: true })
  }

  const openTarget = (item: LogItem) => {
    if (item.kind !== 'line') return
    const primary = primaryRef(item.entry)
    const link = primary ? linkTo(primary.ref) : null
    if (link) void navigate({ to: link.to as never, search: link.search as never })
  }

  const downloads = {
    ndjson: () => void download(exportUrl(view, 'ndjson')),
    text: () => void download(exportUrl(view, 'text')),
  }
  const copyVisible = () => {
    const lines = lineRows(feed).flatMap((row) =>
      row.repeat > 1 ? [row.entry, row.last] : [row.entry],
    )
    void copy(
      entriesAsText(lines),
      `Copied ${formatNumber(lines.length)} ${lines.length === 1 ? 'line' : 'lines'}`,
    )
  }
  const canClear = state.mode === 'tail' && state.phase === 'ready'
  const clearView = () => {
    if (!canClear) return
    const at = feed.newestCursor()
    if (!at) return
    useLogsUi.getState().collapseAll()
    setCursor(undefined)
    update({ entry: undefined }, { replace: true })
    setCleared({ cursor: at, at: new Date().toISOString() })
  }
  const showCleared = () => setCleared(undefined)

  const lineActions = {
    copy: (entry: LogEntry) => void copy(entryAsText(entry), 'Copied the line'),
    copyJson: (entry: LogEntry) => void copy(entryAsJson(entry), 'Copied the line as JSON'),
    hideLike: (entry: LogEntry) => setQ(addTerm(q, hideLikeTerm(entry.message))),
    showInvocation: (execution: string) => setQ(addTerm(q, executionTerm(execution))),
    around: (entry: LogEntry) => {
      setOpenEntry(entry.cursor)
      setCursor(entry.cursor)
      update({ ...aroundWindow(entry.time), entry: entry.cursor, paused: true })
    },
    fromHere: (entry: LogEntry) => update({ from: entry.time, to: undefined }),
  }
  const inspectorActions: InspectorActions = {
    ...lineActions,
    filterPayload,
    backToLatest,
  }

  const menuItems = (entry: LogEntry): RowMenuItem[] => {
    const items: RowMenuItem[] = [
      { id: 'copy', label: 'Copy', shortcut: 'c', run: () => lineActions.copy(entry) },
      {
        id: 'copy-json',
        label: 'Copy JSON',
        shortcut: 'Shift+C',
        run: () => lineActions.copyJson(entry),
      },
      { id: 'hide-like', label: 'Hide lines like this', run: () => lineActions.hideLike(entry) },
    ]
    if (entry.execution) {
      const execution = entry.execution
      items.push({
        id: 'invocation',
        label: 'Show this invocation',
        run: () => lineActions.showInvocation(execution),
      })
    }
    items.push(
      { id: 'around', label: 'Lines around this one', run: () => lineActions.around(entry) },
      { id: 'from-here', label: 'From here on', run: () => lineActions.fromHere(entry) },
    )
    const primary = primaryRef(entry)
    const link = primary ? linkTo(primary.ref) : null
    if (primary && link)
      items.push({
        id: 'open',
        label: primary.label,
        shortcut: 'o',
        run: () => void navigate({ to: link.to as never, search: link.search as never }),
      })
    return items
  }

  // One row menu for the page: right-click on a row, or Shift+F10 on the cursor row.
  const [menu, setMenu] = useState<{ anchor: RowMenuAnchor; entry: LogEntry } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const onContextMenu = (event: MouseEvent) => {
    const element = (event.target as Element | null)?.closest('[data-key]')
    const key = element?.getAttribute('data-key') ?? undefined
    const row = lineAt(feed, key)
    if (!row) return
    event.preventDefault()
    setCursor(row.key)
    if (!paused) update({ paused: true }, { replace: true })
    setMenu({ anchor: { x: event.clientX, y: event.clientY }, entry: row.entry })
  }
  const cursorRow = () => lineAt(feed, cursor ?? search.entry)

  const flipped = useRef<string | undefined>(undefined)
  useLogsShortcuts({
    escape: () => {
      if (search.entry !== undefined) {
        closeLine()
        return true
      }
      if (cursor !== undefined) {
        setCursor(undefined)
        return true
      }
      return false
    },
    errorsOnly: () => {
      const next = flipLevelView(q, LEVEL_VIEWS.errors, flipped.current)
      flipped.current = next.previous
      setQ(next.q)
    },
    warningsAndErrors: () => {
      const next = flipLevelView(q, LEVEL_VIEWS.problems, flipped.current)
      flipped.current = next.previous
      setQ(next.q)
    },
    clearView,
    canClear: () => canClear,
    copyCursor: (json) => {
      const row = cursorRow()
      if (!row) return false
      if (json) lineActions.copyJson(row.entry)
      else lineActions.copy(row.entry)
      return true
    },
    hasCursor: () => (cursor ?? search.entry) !== undefined,
    nextProblem: (step) => {
      const next = stepLine(feed, cursor ?? search.entry, step, (row) => isProblemLine(row.entry))
      if (next) {
        setCursor(next.key)
        setJump({ key: next.key, generation: state.generation })
        if (search.entry !== undefined) openLine(next.key)
        else if (!paused) update({ paused: true }, { replace: true })
      } else if (step === -1) feed.loadOlder()
    },
    openRowMenu: () => {
      const row = cursorRow()
      if (!row) return
      const element = listRef.current?.querySelector(`[data-key="${CSS.escape(row.key)}"]`)
      if (element) setMenu({ anchor: element, entry: row.entry })
    },
  })

  useLogsPalette(
    {
      internals:
        checked.ok &&
        checked.query.terms.some(
          (term) => term.key === 'is' && term.value === 'internal' && !term.negated,
        ),
      paused,
      cleared: cleared !== undefined,
      canClear,
      reloaded: Boolean(facets.data?.lastReload),
      wrap,
      keep,
      saved,
      facets: facets.data,
    },
    {
      setQ: (next) => setQ(next),
      toggleInternals: () => setQ(toggleFacet(q, 'is:internal')),
      setPaused: (next) => onFollowChange(!next),
      clearView,
      showCleared,
      setWindow: (from) => setWindow({ from, to: undefined }),
      downloadNdjson: downloads.ndjson,
      downloadText: downloads.text,
      copyVisible,
      setWrap,
      setKeep,
      applySaved: (filter: SavedFilter) =>
        update({ q: filter.q || undefined, from: filter.from, to: filter.to }),
      addTerm: (term) => setQ(addTerm(q, term)),
    },
  )

  const narrowed = q.trim() !== '' || search.from !== undefined || search.to !== undefined
  const edges: EdgeFacts = {
    evicted: facets.data !== undefined && facets.data.logged > facets.data.kept,
    debugLog: engine.data?.config?.debugLog,
    narrowed,
    clearedAt: cleared?.at,
    startedAt: status.data?.startedAt,
    showCleared,
  }
  const following = !paused
  const wrapNow = wrap && !(state.fast && following)
  const live = state.live === 'ended' || state.live === 'refused' ? state.live : undefined

  const empty = (() => {
    if (state.phase === 'failed')
      return (
        <QueryError
          error={state.error}
          onRetry={() => request && feed.open(request)}
          section="logs"
        />
      )
    if (state.phase === 'loading') return <TableSkeleton columns={LOG_SKELETON} rows={12} />
    if (facets.data && facets.data.kept === 0 && !narrowed)
      return (
        <EmptyState
          icon={ScrollIcon}
          title="Nothing logged yet"
          description="Lines from every service land here as they happen: Functions output, triggers, rules reloads and denials, Auth codes and links."
          testId="logs-empty"
        />
      )
    return (
      <NoLines
        q={q}
        facets={facets.data}
        windowed={search.from !== undefined || search.to !== undefined}
        onClear={() => update({ q: undefined, from: undefined, to: undefined })}
      />
    )
  })()

  const histogramData = histogram.data
  const buckets = histogramData ? levelBuckets(histogramData.buckets) : []

  return (
    <SectionPage section="logs" title="Logs" testId="logs-page">
      <FacetsPanel
        q={q}
        onChange={(next) => setQ(next)}
        facets={checked.ok && refusal === undefined ? facets.data : undefined}
      />
      <SectionToolbar>
        <ToolbarRow testId="logs-toolbar">
          <PanelToggle where="toolbar" />
          <RangePicker
            from={search.from}
            to={search.to}
            lastReload={facets.data?.lastReload}
            kept={facets.data?.kept}
            onChange={setWindow}
          />
          <div
            className="mx-2 flex min-w-0 flex-1 items-center"
            // The lines the strip draws, for a check against the engine's histogram.
            data-total={
              histogramData
                ? histogramData.buckets.reduce((sum, bucket) => sum + bucketTotal(bucket), 0)
                : undefined
            }
            data-testid="logs-volume-total"
          >
            {histogramData && (
              <LevelStrip
                buckets={buckets}
                height={24}
                label="Lines over the window, by level: click a bar or drag across bars to read that time"
                tooltip={(index) => {
                  const bucket = histogramData.buckets[index]
                  if (!bucket) return ''
                  const start = Date.parse(histogramData.from) + index * histogramData.bucketMs
                  return bucketSentence(bucket, bucketSpan(start, histogramData.bucketMs))
                }}
                onPick={(low, high) => setWindow(bucketWindow(histogramData, low, high))}
                className="w-full"
                testId="logs-volume"
              />
            )}
          </div>
          <ToolbarDivider />
          {live && (
            <LiveNotice
              status={live}
              what="the log"
              message={state.liveError?.message}
              onRetry={() => liveChannel.retry()}
            />
          )}
          <LogMenu
            wrap={wrap}
            keep={keep}
            cleared={cleared !== undefined}
            canClear={canClear ? undefined : 'Back to the latest lines first'}
            hasFilter={narrowed}
            saved={saved}
            actions={{
              downloadNdjson: downloads.ndjson,
              downloadText: downloads.text,
              copyVisible,
              clearView,
              showCleared,
              setWrap,
              setKeep,
              applySaved: (filter) =>
                update({ q: filter.q || undefined, from: filter.from, to: filter.to }),
              save: (name) => saveFilter(project, { name, q, from: search.from, to: search.to }),
              forget: (name) => forgetFilter(project, name),
            }}
          />
        </ToolbarRow>
        <ToolbarRow variant="line" testId="logs-query">
          <div
            className="flex min-w-0 flex-1"
            onKeyDownCapture={(event) => {
              if (event.key !== 'Enter') return
              // Enter that picks a completion is the field's own.
              const expandedList = event.currentTarget
                .querySelector('[role="combobox"]')
                ?.getAttribute('aria-expanded')
              if (expandedList !== 'true') commitTyped()
            }}
            onBlur={commitTyped}
          >
            <FilterField
              value={q}
              onChange={onFilterChange}
              fields={fields}
              placeholder={LOGS_PLACEHOLDER}
              ariaLabel="Filter the log"
              regex
              refusal={refusal}
              testId="logs-filter"
            />
          </div>
          <MatchCount
            total={facets.data ? { count: facets.data.matched, exact: true } : undefined}
            noun={LINE_NOUN}
            loading={facets.isFetching && facets.isPlaceholderData}
            widest="00,000 lines"
            tooltip="Lines that match these filters among the 20,000 the engine keeps, and the 2,000 problems it keeps longer."
            failed={facets.isError && refusal === undefined}
            hidden={!checked.ok || refusal !== undefined}
            testId="logs-match-count"
          />
          <FeedPause feed={feed} paused={paused} onChange={(next) => onFollowChange(!next)} />
        </ToolbarRow>
      </SectionToolbar>
      <SectionBody testId="logs-body">
        <div
          ref={listRef}
          className="relative flex min-w-0 flex-1 flex-col bg-kumo-base"
          onContextMenu={onContextMenu}
          onPointerDownCapture={(event) => {
            // A row pressed with the pointer opens in the inspector; one
            // reached with the keys only moves the cursor.
            const key = (event.target as Element | null)
              ?.closest('[data-key]')
              ?.getAttribute('data-key')
            if (key) pressed.current = { key, at: Date.now() }
          }}
          data-testid="logs-list"
        >
          {!checked.ok ? (
            <FilterProblem
              message={checked.error.message}
              onClear={() => update({ q: undefined })}
            />
          ) : refusal ? (
            <QueryError error={refusedBy} onRetry={() => void facets.refetch()} />
          ) : (
            <>
              <FeedList<LogItem>
                ariaLabel="Log lines"
                store={feed.store}
                order="newest-last"
                rowHeight={24}
                rowKey={itemKey}
                renderRow={(item) => (
                  <LogRow
                    item={item}
                    wrap={wrapNow}
                    expanded={expanded.has(item.key)}
                    highlight={highlight}
                    actions={rowActions}
                    edges={edges}
                  />
                )}
                expanded={expanded}
                wrap={wrapNow}
                renderExpanded={(item) =>
                  item.kind === 'line' ? (
                    <LogDetail
                      entry={item.entry}
                      wrap={wrapNow}
                      highlight={highlight}
                      onFilter={filterPayload}
                    />
                  ) : null
                }
                onToggleExpanded={(key, open) => toggleExpanded(key, open)}
                renderMarker={(row) => <FeedMarker text={row.text} action={row.action} />}
                selectedKey={cursor ?? search.entry}
                onSelect={onSelect}
                onOpenTarget={openTarget}
                pausedMode="freeze"
                follow={following}
                onFollowChange={onFollowChange}
                hasMore={state.hasMore}
                loadMore={feed.loadOlder}
                scrollToKey={
                  jump?.generation === state.generation
                    ? { key: jump.key, align: 'center' }
                    : state.focus
                      ? { key: state.focus.key, align: state.focus.align }
                      : undefined
                }
                empty={empty}
                testId="logs-feed"
              />
              {state.phase === 'ready' && linesLoaded > 0 && (
                <FeedFooter
                  loaded={linesLoaded}
                  capacity={ENGINE_KEEPS}
                  noun={LINES}
                  testId="logs-footer"
                />
              )}
            </>
          )}
          {state.loadingOlder && (
            <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
              <span
                className="rounded-full bg-kumo-base px-3 py-1 text-[12px] text-kumo-subtle shadow-md ring ring-kumo-line"
                data-testid="logs-loading-older"
              >
                Loading older lines…
              </span>
            </div>
          )}
          {state.mode === 'around' && state.phase === 'ready' && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
              <Tooltip
                content="Open the newest lines and follow them · End"
                render={
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ArrowDownIcon />}
                    className="pointer-events-auto shadow-md ring ring-kumo-line"
                    onClick={backToLatest}
                    data-testid="logs-back-to-latest"
                  >
                    Back to the latest
                  </Button>
                }
              />
            </div>
          )}
        </div>
        {search.entry !== undefined && project !== '' && (
          <InspectorHost
            feed={feed}
            entryKey={search.entry}
            project={project}
            highlight={highlight}
            actions={inspectorActions}
            onClose={closeLine}
            onSelect={(key) => openLine(key)}
          />
        )}
      </SectionBody>
      <CursorPalette feed={feed} cursorKey={cursor ?? search.entry} items={menuItems} />
      <RowMenuPopup
        items={menu ? menuItems(menu.entry) : []}
        open={menu !== null}
        onOpenChange={(open) => {
          if (!open) setMenu(null)
        }}
        anchor={menu?.anchor ?? null}
        testId="log-row-menu"
      />
    </SectionPage>
  )
}

/** The pause button, with what arrived while paused: it reads the feed store, so it renders alone. */
function FeedPause({
  feed,
  paused,
  onChange,
}: {
  feed: LogFeed
  paused: boolean
  onChange: (paused: boolean) => void
}) {
  const pending = useFeedPending(feed.store, paused, itemKey, 'freeze')
  return <PauseButton paused={paused} pending={pending} onChange={onChange} testId="logs-pause" />
}

/** The cursor row's menu in ⌘K ("This line › Copy JSON"): it reads the feed store, so it renders alone. */
function CursorPalette({
  feed,
  cursorKey,
  items,
}: {
  feed: LogFeed
  cursorKey: string | undefined
  items: (entry: LogEntry) => RowMenuItem[]
}) {
  // It reads the feed store while it renders (see InspectorHost).
  'use no memo'
  useFeed(feed.store)
  const row = lineAt(feed, cursorKey)
  useRowMenuPalette(row ? items(row.entry) : undefined, 'This line')
  return null
}

/** The inspector for the URL's line, read from the feed store where the feed holds it. */
function InspectorHost({
  feed,
  entryKey,
  project,
  highlight,
  actions,
  onClose,
  onSelect,
}: {
  feed: LogFeed
  entryKey: string
  project: string
  highlight: ReturnType<typeof highlighter>
  actions: InspectorActions
  onClose: () => void
  onSelect: (key: string) => void
}) {
  // It reads the feed store while it renders, and the store is mutable: the
  // compiler may keep such a read for as long as the store is the same object.
  'use no memo'
  useFeed(feed.store)
  const row = lineAt(feed, entryKey)
  const previous = row ? stepLine(feed, entryKey, -1) : undefined
  const next = row ? stepLine(feed, entryKey, 1) : undefined
  return (
    <LogInspector
      cursor={entryKey}
      entry={row?.entry}
      repeat={row?.repeat ?? 1}
      last={row?.last}
      project={project}
      highlight={highlight}
      actions={actions}
      onClose={onClose}
      onPrev={previous ? () => onSelect(previous.key) : undefined}
      onNext={next ? () => onSelect(next.key) : undefined}
    />
  )
}

/** The skeleton's cells while the first page is on its way: time, level, source, message. */
const LOG_SKELETON = [{ width: 104 }, { width: 64 }, { width: 140 }, { width: 520 }]

const LINES = { one: 'line', other: 'lines' }

/** The lines the store holds, a repeated line counted as often as it was printed. */
function useLineCount(store: FeedStore<LogItem>): number {
  // It walks the mutable store while rendering: the compiler would keep the
  // first answer for as long as the store is the same object.
  'use no memo'
  useFeed(store)
  let lines = 0
  for (let index = 0; index < store.size(); index += 1) {
    const row = store.at(index)
    if (row?.kind === 'item' && row.item.kind === 'line') lines += row.item.repeat
  }
  return lines
}

/** A filter that does not parse: why, and the way out; never the last good rows. */
function FilterProblem({ message, onClear }: { message: string; onClear: () => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="logs-filter-problem">
      <Empty
        icon={<FunnelIcon size={48} className="text-kumo-inactive" />}
        title={message}
        description="Fix the filter above, or clear it."
        contents={
          <Button variant="secondary" onClick={onClear} data-testid="logs-filter-problem-clear">
            Clear the filter
          </Button>
        }
      />
    </div>
  )
}
