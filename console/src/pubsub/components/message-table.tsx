// A topic's messages, newest first: every message the engine still keeps in
// the topic's history, filtered by the shared grammar (`q`) and by a Pub/Sub
// filter expression over attributes (`expr`), each row saying what became
// of the message at every subscription and function.
//
// Following. The list grows only at its head, so a publish never patches a
// row: while the window starts at the head and holds a page or two, the
// loaded pages are read again (in order, from the first, so they stay
// contiguous) and the rows above the head last drawn flash. Scrolled further
// away, nothing is read: the table keeps what is under the reader still and
// its pill counts what arrived ("↑ 12 new · Show"), counted by the engine
// when a filter is in force. The marks of loaded rows move all the time —
// a subscriber acks, a function finishes — and those rows are patched in
// place through `POST /pubsub/messages:batchGet`, wherever the reader is.

import { Button, Tooltip, cn } from '@cloudflare/kumo'
import {
  CheckIcon,
  CopyIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  type Icon,
  LightningIcon,
  MinusIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
  QuestionIcon,
  SidebarSimpleIcon,
  TrayIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import type { PubsubDeliverySummary } from '@/api/generated/messaging/PubsubDeliverySummary'
import type { PubsubMessageDetail } from '@/api/generated/messaging/PubsubMessageDetail'
import type { PubsubMessageRow } from '@/api/generated/messaging/PubsubMessageRow'
import type { PubsubTopicDetail } from '@/api/generated/messaging/PubsubTopicDetail'
import {
  DataTable,
  type DataTableColumn,
  useHiddenColumnCount,
} from '@/components/console/data-table'
import { EmptyState, NoMatch, QueryError } from '@/components/console/empty-state'
import { ExportDialog } from '@/components/console/export-dialog'
import { FilterField } from '@/components/console/filter-field'
import { MatchCount } from '@/components/console/match-count'
import { RelativeTime } from '@/components/console/relative-time'
import { SelectionBar } from '@/components/console/selection-bar'
import type { RowMenuItem } from '@/components/console/row-menu'
import { TableFooter } from '@/components/console/table-footer'
import { ToolbarRow } from '@/components/console/toolbar'
import type { CursorPages } from '@/components/console/use-cursor-rows'
import { FLASH_MS, useCursorRows } from '@/components/console/use-cursor-rows'
import { checkFilter } from '@/lib/filter'
import { formatNumber } from '@/lib/format'
import { useShortcuts } from '@/lib/shortcuts'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { toast } from '@/lib/toasts'
import { compareIds, dedupeRows, idsAbove } from '@/messaging/rows'
import { MESSAGE_FIELDS, MESSAGE_FILTER_PLACEHOLDER, messageFields } from '../filters'
import { useTopicLive } from '../live'
import { shortName } from '../names'
import { previewText } from '../payload'
import { messagesExportUrl } from '../api'
import { messageList, messageQuery } from '../queries'
import { type MarkShape, evictedText, functionMark, subscriptionMark } from '../states'
import { AttributesFilterField, filterCheckText, useFilterCheck } from './attributes-filter-field'
import { type MessageTab, MessageInspector } from './message-inspector'
import { type AgainRequest, PublishAgainDialog } from './publish-again-dialog'

/** What the page's table needs from its search parameters, and how it writes them. */
export interface MessagesSearch {
  q?: string | undefined
  expr?: string | undefined
  message?: string | undefined
  tab?: MessageTab | undefined
}

const NOUN = { one: 'message', other: 'messages' }

/** The most ticked messages Copy reads one by one; Export takes any number. */
const COPY_LIMIT = 100

/** The 7 px circle a subscription mark is drawn as. */
const MARK: Record<Exclude<MarkShape, 'none'>, string> = {
  hollow: 'border border-kumo-interact',
  half: 'border border-kumo-brand bg-[linear-gradient(90deg,var(--color-kumo-brand)_50%,transparent_50%)]',
  filled: 'bg-kumo-interact',
  danger: 'bg-kumo-danger',
  dashed: 'border border-dashed border-kumo-interact',
}

const GLYPH: Record<ReturnType<typeof functionMark>['glyph'], Icon> = {
  check: CheckIcon,
  x: XIcon,
  dots: DotsThreeIcon,
  minus: MinusIcon,
  question: QuestionIcon,
}

const TONE_TEXT: Record<ReturnType<typeof functionMark>['tone'], string> = {
  success: 'text-kumo-success',
  danger: 'text-kumo-danger',
  brand: 'text-kumo-brand',
  warning: 'text-kumo-warning',
  neutral: 'text-kumo-subtle',
}

/** Where a message went, as one line for the marks' tooltip. */
export function deliveriesText(deliveries: PubsubDeliverySummary): string {
  const lines = deliveries.subscriptions.map(
    (at) => `${shortName(at.subscription)}: ${subscriptionMark(at.state).word}`,
  )
  if (deliveries.more > 0) lines.push(`and ${formatNumber(deliveries.more)} more subscriptions`)
  for (const target of deliveries.functions)
    lines.push(
      `${shortName(target.functionId).replace(/^[a-z]+-[a-z]+\d+-/, '')}: ${functionMark(target.mark).word}`,
    )
  return lines.length > 0 ? lines.join('\n') : 'No subscription or function received it.'
}

/** One mark per subscription, then one per function. */
export function DeliveryMarks({ deliveries }: { deliveries: PubsubDeliverySummary }) {
  const marks: ReactNode[] = []
  for (const at of deliveries.subscriptions) {
    const shape = subscriptionMark(at.state).shape
    marks.push(
      shape === 'none' ? (
        <span key={at.subscription} className="size-[7px] shrink-0" />
      ) : (
        <span
          key={at.subscription}
          className={cn('size-[7px] shrink-0 rounded-full', MARK[shape])}
          data-state={at.state}
        />
      ),
    )
  }
  for (const target of deliveries.functions) {
    const look = functionMark(target.mark)
    const Glyph = GLYPH[look.glyph]
    marks.push(
      <span
        key={target.functionId}
        className={cn('flex shrink-0 items-center', TONE_TEXT[look.tone])}
        data-mark={target.mark}
      >
        <LightningIcon size={12} weight="fill" className="text-kumo-subtle" />
        <Glyph size={11} weight="bold" />
      </span>,
    )
  }
  return (
    <Tooltip
      content={<span className="whitespace-pre-line">{deliveriesText(deliveries)}</span>}
      render={
        <span
          className="inline-flex items-center gap-1.5 align-middle"
          data-testid="delivery-marks"
        >
          {marks}
          {deliveries.more > 0 && (
            <span className="text-[11px] text-kumo-subtle">+{formatNumber(deliveries.more)}</span>
          )}
        </span>
      }
    />
  )
}

/** Attributes as chips, three and then a count. */
export function AttributeChips({ attributes }: { attributes: { [key in string]: string } }) {
  const entries = Object.entries(attributes)
  if (entries.length === 0) return <span className="text-kumo-inactive">—</span>
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {entries.slice(0, 3).map(([key, value]) => (
        <span
          key={key}
          className="max-w-28 truncate rounded bg-kumo-tint px-1 text-[11px] text-kumo-default"
        >
          {key}={value}
        </span>
      ))}
      {entries.length > 3 && (
        <span className="text-[11px] text-kumo-subtle">+{entries.length - 3}</span>
      )}
    </span>
  )
}

export const MESSAGE_COLUMNS: readonly DataTableColumn<PubsubMessageRow>[] = [
  {
    id: 'published',
    header: 'Published',
    width: 96,
    cell: (row) => <RelativeTime iso={row.publishTime} />,
    copy: (row) => row.publishTime,
  },
  { id: 'id', header: 'id', width: 72, align: 'end', cell: (row) => row.id },
  {
    id: 'data',
    header: 'Data',
    width: 360,
    cell: (row) => (
      <span className={row.data.encoding === 'binary' ? 'text-kumo-subtle' : undefined}>
        {previewText(row.data, row.size)}
      </span>
    ),
    copy: (row) => row.data.text,
  },
  {
    id: 'attributes',
    header: 'Attributes',
    width: 200,
    cell: (row) => <AttributeChips attributes={row.attributes} />,
    copy: (row) => JSON.stringify(row.attributes),
  },
  {
    id: 'key',
    header: 'Key',
    width: 96,
    cell: (row) => row.orderingKey ?? <span className="text-kumo-inactive">—</span>,
    copy: (row) => row.orderingKey ?? '',
  },
  {
    id: 'delivered',
    header: 'Delivered',
    width: 112,
    cell: (row) => <DeliveryMarks deliveries={row.deliveries} />,
    copy: (row) => deliveriesText(row.deliveries),
  },
]

/** A filter text the engine would refuse is never sent: the field says why instead. */
function usableQuery(q: string): string | undefined {
  if (!q.trim()) return undefined
  return checkFilter(q, { fields: MESSAGE_FIELDS }).ok ? q : undefined
}

export function MessagesView({
  project,
  topic,
  detail,
  search,
  update,
  onLiveStatus,
  onOpenSubscription,
  composer,
  onEditAgain,
  above,
  exportOpen = false,
  onExportOpenChange,
  empty,
  fixedExpr,
  columns = MESSAGE_COLUMNS,
  memoryKey = 'pubsub.messages',
  againLabel,
  emptyState: emptyOverride,
}: {
  project: string
  topic: string
  detail: PubsubTopicDetail | undefined
  search: MessagesSearch
  update: (patch: Partial<MessagesSearch>, options?: { replace?: boolean }) => void
  /** This page's own subscription to the topic, for row one's notice. */
  onLiveStatus: (status: SubscriptionStatus) => void
  onOpenSubscription: (name: string) => void
  /** The occupant of the inspector's slot instead of a message (the composer). */
  composer?: ReactNode
  /**
   * Opens the composer filled with a message (Shift+R, "Edit and publish…").
   * With it, rows can also be published again as they are (`r`, ticked rows).
   */
  onEditAgain?: ((id: string) => void) | undefined
  /** Lines between the filter and the table: the running publish jobs. */
  above?: ReactNode
  /** The export dialog (`dialog=export`), for what the filters match or the ticked rows. */
  exportOpen?: boolean
  onExportOpenChange?: ((open: boolean) => void) | undefined
  /** The empty state's action (Publish), when the topic has nothing yet. */
  empty?: ReactNode
  /**
   * An expression the view holds fixed (a subscription's dead letters): it
   * narrows every read and shows as a read-only chip in the field's place.
   */
  fixedExpr?: { expr: string; chip: string } | undefined
  columns?: readonly DataTableColumn<PubsubMessageRow>[]
  memoryKey?: string
  /**
   * Publishing again goes to another topic (a dead letter back to its
   * source): only "edit and publish", under these words, is offered.
   */
  againLabel?: string | undefined
  /** The empty state with no filter typed, in place of the topic's own. */
  emptyState?: ReactNode
}) {
  const queryClient = useQueryClient()
  const topicId = shortName(topic)

  // The filter text runs ahead of the URL, which follows it shortly after.
  // The query field keeps its own draft and tells an echo of what it typed
  // from a change made elsewhere; the expression field is drawn from here,
  // so the same rule is kept here: a URL value this page wrote is an echo.
  const timers = useRef<{
    q?: ReturnType<typeof setTimeout>
    expr?: ReturnType<typeof setTimeout>
  }>({})
  useEffect(
    () => () => {
      clearTimeout(timers.current.q)
      clearTimeout(timers.current.expr)
    },
    [],
  )
  const writeQ = (text: string) => {
    clearTimeout(timers.current.q)
    timers.current.q = setTimeout(() => update({ q: text || undefined }, { replace: true }), 250)
  }
  const urlExpr = search.expr ?? ''
  const [exprText, setExprText] = useState(urlExpr)
  const [writtenExpr, setWrittenExpr] = useState(urlExpr)
  const [seenExpr, setSeenExpr] = useState(urlExpr)
  if (urlExpr !== seenExpr) {
    setSeenExpr(urlExpr)
    if (urlExpr !== writtenExpr) setExprText(urlExpr)
  }
  const writeExpr = (text: string) => {
    setExprText(text)
    clearTimeout(timers.current.expr)
    timers.current.expr = setTimeout(() => {
      setWrittenExpr(text)
      update({ expr: text || undefined }, { replace: true })
    }, 300)
  }

  // The URL's expression has settled already; the list waits for the
  // engine's word on it rather than asking with a filter it would refuse.
  const ownExpr = fixedExpr ? undefined : search.expr
  const exprCheck = useFilterCheck(project, ownExpr ?? '', topic, 0)
  const exprKnown = !ownExpr || exprCheck.check !== undefined
  const q = usableQuery(search.q ?? '')
  const exprBroken = exprCheck.check !== undefined && !exprCheck.check.ok
  const typedExpr = ownExpr && !exprBroken ? ownExpr : undefined
  const expr = fixedExpr?.expr ?? typedExpr
  const filtered = q !== undefined || typedExpr !== undefined

  const list = messageList(project, topic, q, expr)
  const query = useInfiniteQuery({ ...list.options, enabled: list.options.enabled && exprKnown })
  const cursor = useCursorRows(query, { ...list, q })
  const rows = dedupeRows(cursor.rows, (row) => row.id)

  // Rows above the head last drawn flash once they are read in.
  const [created, setCreated] = useState<ReadonlyMap<string, 'created'>>(new Map())
  const lastHead = useRef<{ key: string; id: string | undefined }>({ key: '', id: undefined })
  const listKey = list.queryKey.join('\u0000')
  useEffect(() => {
    const head = cursor.hasPrevious ? undefined : rows[0]?.id
    const before = lastHead.current
    if (before.key !== listKey) {
      lastHead.current = { key: listKey, id: head }
      return
    }
    if (head === undefined) return
    const newer = idsAbove(rows, (row) => row.id, before.id)
    lastHead.current = {
      key: listKey,
      id: before.id === undefined || compareIds(head, before.id) > 0 ? head : before.id,
    }
    if (newer.length === 0) return
    setCreated((current) => {
      const next = new Map(current)
      for (const id of newer) next.set(id, 'created')
      return next
    })
    const timer = setTimeout(
      () =>
        setCreated((current) => {
          const next = new Map(current)
          for (const id of newer) next.delete(id)
          return next
        }),
      FLASH_MS,
    )
    return () => clearTimeout(timer)
  }, [rows, listKey, cursor.hasPrevious])
  const flashes = new Map<string, 'created' | 'updated'>([...cursor.flashes, ...created])

  // Following the head.
  const [newAbove, setNewAbove] = useState(0)
  const refetching = useRef<{ running: boolean; again: boolean }>({ running: false, again: false })
  const readHead = async () => {
    const state = refetching.current
    if (state.running) {
      state.again = true
      return
    }
    state.running = true
    try {
      await queryClient.refetchQueries({ queryKey: list.queryKey, exact: true })
    } finally {
      state.running = false
      if (state.again) {
        state.again = false
        void readHead()
      }
    }
  }
  const live = useTopicLive(project, topic, undefined, {
    onPublished: (published) => {
      const data = queryClient.getQueryData<CursorPages<PubsubMessageRow>>(list.queryKey)
      if (!data) return
      const atHead = !cursor.hasPrevious && data.pages.length <= 2
      if (atHead) {
        void readHead()
        return
      }
      if (
        published.overflow ||
        (expr === undefined && q === undefined) ||
        published.ids.length === 0
      ) {
        setNewAbove((count) => count + published.added)
        return
      }
      // A filter is in force: the engine says which of the new ones match.
      void list
        .batchGet(
          { keys: published.ids, ...(q ? { q } : {}), pageStarts: [] },
          new AbortController().signal,
        )
        .then((answer) => {
          const matched = answer.items.filter((item) => item.row !== null).length
          if (matched > 0) setNewAbove((count) => count + matched)
        })
        .catch(() => undefined)
    },
    onMessageKeys: (ids) => {
      const loaded = new Set(rows.map((row) => row.id))
      const keys = ids.filter((id) => loaded.has(id))
      if (keys.length > 0) cursor.applyKeys(keys)
    },
    onReset: () => {
      setNewAbove(0)
      cursor.reset()
    },
  })
  useEffect(() => onLiveStatus(live), [live, onLiveStatus])

  const fields = messageFields({
    attributeKeys: detail?.attributeKeys ?? [],
    orderingKeys: detail?.orderingKeys ?? [],
  })
  const hidden = useHiddenColumnCount(memoryKey, columns)
  const republish = onEditAgain !== undefined && againLabel === undefined
  const exprLine = filterCheckText(exprCheck.check, false)

  // Ticked rows: for a list, a selection belongs to one filter of one topic.
  const [selection, setSelection] = useState<{
    key: string
    checked: ReadonlySet<string>
    everything: boolean
  }>({ key: listKey, checked: new Set(), everything: false })
  const ticked =
    selection.key === listKey
      ? selection
      : { key: listKey, checked: new Set<string>(), everything: false }
  const clearSelection = () => setSelection({ key: listKey, checked: new Set(), everything: false })
  const selecting = ticked.checked.size > 0 || ticked.everything
  const tickedCount = ticked.everything
    ? (cursor.total?.count ?? ticked.checked.size)
    : ticked.checked.size
  const queryTarget: BulkTarget = {
    by: 'query',
    q: q ?? '',
    scope: { topic, ...(expr ? { expr } : {}) },
  }
  const selectedTarget: BulkTarget = ticked.everything
    ? queryTarget
    : { by: 'keys', keys: [...ticked.checked] }

  // Whether the export is of the ticked rows rather than what the filters match.
  const [exportSelected, setExportSelected] = useState(false)

  // Publishing again, as they are: one message from its row, or the ticked ones.
  const [again, setAgain] = useState<AgainRequest | null>(null)
  const againOne = (id: string) => setAgain({ target: { by: 'keys', keys: [id] }, count: 1 })

  // The table's cursor row, for the row keys.
  const [cursorId, setCursorId] = useState<string | undefined>(undefined)
  const cursorRow = rows.find((row) => row.id === cursorId)
  useShortcuts(
    { id: 'pubsub-messages', label: 'Messages' },
    onEditAgain
      ? [
          {
            key: 'r',
            label: 'Publish the message again',
            when: () => republish && cursorRow !== undefined,
            run: () => {
              if (cursorRow) againOne(cursorRow.id)
            },
          },
          {
            key: 'Shift+R',
            label: againLabel ?? 'Edit the message, then publish it',
            when: () => cursorRow !== undefined,
            run: () => {
              if (cursorRow) onEditAgain(cursorRow.id)
            },
          },
        ]
      : [],
  )

  const copyAsJson = async (row: PubsubMessageRow) => {
    try {
      const message = await queryClient.fetchQuery(messageQuery(project, topic, row.id))
      const text = JSON.stringify(messageJson(message), null, 2)
      await navigator.clipboard.writeText(text)
      toast({ key: 'pubsub-copy', title: `Copied message ${row.id} as JSON` })
    } catch {
      toast({ key: 'pubsub-copy', title: 'Could not copy the message', tone: 'danger' })
    }
  }
  const copySelected = async () => {
    try {
      const messages = await Promise.all(
        Array.from(ticked.checked, (id) =>
          queryClient.fetchQuery(messageQuery(project, topic, id)),
        ),
      )
      const text = JSON.stringify(messages.map(messageJson), null, 2)
      await navigator.clipboard.writeText(text)
      toast({
        key: 'pubsub-copy',
        title: `Copied ${formatNumber(messages.length)} ${messages.length === 1 ? 'message' : 'messages'} as JSON`,
      })
    } catch {
      toast({ key: 'pubsub-copy', title: 'Could not copy the messages', tone: 'danger' })
    }
  }

  const rowMenu = (row: PubsubMessageRow): RowMenuItem[] => [
    {
      id: 'open',
      label: 'Open',
      icon: SidebarSimpleIcon,
      shortcut: 'Enter',
      run: () => update({ message: row.id }),
    },
    ...(republish
      ? [
          {
            id: 'again',
            label: 'Publish again…',
            icon: PaperPlaneTiltIcon,
            shortcut: 'r',
            run: () => againOne(row.id),
          },
        ]
      : []),
    ...(onEditAgain
      ? [
          {
            id: 'edit-again',
            label: againLabel ? `${againLabel}…` : 'Edit and publish…',
            icon: PencilSimpleIcon,
            shortcut: 'Shift+R',
            run: () => onEditAgain(row.id),
          },
        ]
      : []),
    {
      id: 'copy-id',
      label: 'Copy id',
      icon: CopyIcon,
      run: () => {
        void navigator.clipboard
          .writeText(row.id)
          .then(() => toast({ key: 'pubsub-copy', title: `Copied ${row.id}` }))
          .catch(() => toast({ key: 'pubsub-copy', title: 'Could not copy', tone: 'danger' }))
      },
    },
    { id: 'copy-json', label: 'Copy as JSON', icon: CopyIcon, run: () => void copyAsJson(row) },
  ]

  /** The inspector's previous / next: the row that way in the table, if it is loaded. */
  const stepTo = (step: -1 | 1) => {
    const at = rows.findIndex((row) => row.id === search.message)
    const row = at === -1 ? undefined : rows[at + step]
    return row ? () => update({ message: row.id }, { replace: true }) : undefined
  }

  const evicted = detail ? evictedText(detail.history, topicId) : undefined
  const emptyState = filtered ? (
    <NoMatch
      filter={[q, typedExpr].filter(Boolean).join(' · ')}
      onClear={() => update({ q: undefined, expr: undefined }, { replace: true })}
      noun="messages"
    />
  ) : emptyOverride !== undefined ? (
    emptyOverride
  ) : (
    <EmptyState
      icon={TrayIcon}
      title={
        evicted
          ? `No messages of ${topicId} are kept`
          : `Nothing published to ${topicId} since the emulator started`
      }
      description={evicted ?? 'Publish from your app, or from here.'}
      connect={{ service: 'pubsub', project }}
      actions={empty}
      testId="pubsub-messages-empty"
    />
  )

  return (
    <>
      <ToolbarRow
        variant="line"
        testId="pubsub-filter-line"
        overlay={
          selecting ? (
            <SelectionBar
              count={tickedCount}
              total={cursor.total}
              everything={ticked.everything}
              filtered={filtered}
              noun={NOUN}
              onSelectEverything={() =>
                setSelection({ key: listKey, checked: ticked.checked, everything: true })
              }
              onClear={clearSelection}
              testId="pubsub-selection"
              actions={
                <>
                  {republish && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<PaperPlaneTiltIcon />}
                      onClick={() => setAgain({ target: selectedTarget, count: tickedCount })}
                      data-testid="pubsub-selection-again"
                    >
                      Publish again {formatNumber(tickedCount)}
                    </Button>
                  )}
                  <Tooltip
                    content={
                      ticked.everything || ticked.checked.size > COPY_LIMIT
                        ? `Copy takes up to ${COPY_LIMIT}; export the rest`
                        : 'Their data, attributes and keys, as a JSON array'
                    }
                    render={
                      <span className="inline-flex">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<CopyIcon />}
                          disabled={ticked.everything || ticked.checked.size > COPY_LIMIT}
                          onClick={() => void copySelected()}
                          data-testid="pubsub-selection-copy"
                        >
                          Copy {formatNumber(tickedCount)} as JSON
                        </Button>
                      </span>
                    }
                  />
                  {onExportOpenChange && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<DownloadSimpleIcon />}
                      onClick={() => {
                        setExportSelected(true)
                        onExportOpenChange(true)
                      }}
                      data-testid="pubsub-selection-export"
                    >
                      Export {formatNumber(tickedCount)}…
                    </Button>
                  )}
                </>
              }
            />
          ) : undefined
        }
        below={
          exprLine ? (
            <p
              className="m-0 px-3 pb-1.5 text-[12px] text-kumo-danger"
              data-testid="attributes-filter-error"
            >
              {exprLine}
            </p>
          ) : undefined
        }
      >
        <FilterField
          value={search.q ?? ''}
          onChange={writeQ}
          fields={fields}
          placeholder={MESSAGE_FILTER_PLACEHOLDER}
          ariaLabel="Filter messages"
          testId="pubsub-message-filter"
        />
        {fixedExpr ? (
          <Tooltip
            content={<span className="font-mono text-[11px]">{fixedExpr.expr}</span>}
            render={
              <span
                className="flex h-6.5 shrink-0 items-center rounded-md bg-kumo-tint px-2 text-[12px] text-kumo-default"
                data-testid="pubsub-fixed-expr"
              >
                {fixedExpr.chip}
              </span>
            }
          />
        ) : (
          <AttributesFilterField
            value={exprText}
            onChange={writeExpr}
            project={project}
            topic={topic}
            collapsible
            testId="pubsub-expr"
          />
        )}
        <MatchCount
          total={cursor.total}
          scanned={cursor.scanned}
          noun={NOUN}
          loading={query.isPending}
          widest="0,000,000"
          hidden={exprBroken}
          {...(filtered && detail
            ? { detail: `of ${formatNumber(detail.history.messages)} kept` }
            : {})}
          tooltip={`Messages in the console's history of ${topicId}${filtered ? ' that match' : ''}; the engine keeps the newest ${formatNumber(detail?.history.capacityMessages ?? 5000)}.`}
          testId="pubsub-message-count"
        />
      </ToolbarRow>
      {above}
      <div className="relative flex min-h-0 flex-1" data-testid="pubsub-messages">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {query.isError && rows.length === 0 ? (
            <QueryError error={query.error} onRetry={() => void query.refetch()} section="pubsub" />
          ) : (
            <DataTable
              ariaLabel={`Messages of ${topicId}`}
              rows={rows}
              rowKey={(row) => row.id}
              columns={columns}
              memoryKey={memoryKey}
              openKey={search.message}
              onOpen={(row) => update({ message: row.id })}
              onCursorChange={(row) => {
                setCursorId(row.id)
                if (search.message !== undefined && search.message !== row.id)
                  update({ message: row.id }, { replace: true })
              }}
              selection={{
                checked: ticked.checked,
                everything: ticked.everything,
                onChange: (checked, everything) =>
                  setSelection({ key: listKey, checked, everything }),
              }}
              rowClick="open"
              flashes={flashes}
              hasMore={cursor.hasMore}
              loadMore={cursor.loadMore}
              hasPrevious={cursor.hasPrevious}
              loadPrevious={cursor.loadPrevious}
              rowOffset={cursor.rowOffset}
              total={cursor.total}
              anchor="key"
              {...(newAbove > 0 ? { newAbove } : {})}
              onShowNew={() => {
                setNewAbove(0)
                cursor.reset()
              }}
              rowMenu={rowMenu}
              loading={query.isPending}
              empty={emptyState}
              footer={
                rows.length > 0 ? (
                  <TableFooter
                    loaded={rows.length}
                    rowOffset={cursor.rowOffset}
                    total={cursor.total}
                    hasMore={cursor.hasMore}
                    hiddenColumns={hidden.hidden}
                    onShowAll={hidden.showAll}
                    noun={NOUN}
                    actions={
                      onExportOpenChange && !selecting ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          icon={<DownloadSimpleIcon />}
                          onClick={() => {
                            setExportSelected(false)
                            onExportOpenChange(true)
                          }}
                          data-testid="pubsub-export"
                        >
                          Export
                        </Button>
                      ) : undefined
                    }
                    testId="pubsub-messages-footer"
                  />
                ) : undefined
              }
              testId="pubsub-message-table"
            />
          )}
        </div>
        {composer ??
          (search.message !== undefined && (
            <MessageInspector
              project={project}
              topic={topic}
              id={search.message}
              tab={search.tab}
              onTab={(tab) => update({ tab: tab === 'data' ? undefined : tab }, { replace: true })}
              onClose={() => update({ message: undefined, tab: undefined })}
              onPrev={stepTo(-1)}
              onNext={stepTo(1)}
              onOpenSubscription={onOpenSubscription}
              {...(onEditAgain ? { onEditAgain } : {})}
              againLabel={againLabel}
            />
          ))}
      </div>
      {republish && (
        <PublishAgainDialog
          request={again}
          topic={topic}
          onOpenChange={(open) => {
            if (!open) setAgain(null)
          }}
          onStarted={clearSelection}
        />
      )}
      {onExportOpenChange && (
        <ExportDialog
          open={exportOpen}
          onOpenChange={(open) => {
            if (!open) setExportSelected(false)
            onExportOpenChange(open)
          }}
          title={`Export messages of ${topicId}`}
          scope={
            <span data-testid="pubsub-export-scope">
              {exportSelected && !ticked.everything
                ? `The ${formatNumber(ticked.checked.size)} ticked ${ticked.checked.size === 1 ? 'message' : 'messages'} of ${topicId}`
                : `${cursor.total ? `${formatNumber(cursor.total.count)}${cursor.total.exact ? '' : '+'} ` : ''}messages of ${topicId}${fixedExpr ? ` ${fixedExpr.chip}` : ''}${filtered ? ` matching ${[q, typedExpr].filter(Boolean).join(' and ')}` : fixedExpr ? '' : ' the console keeps'}`}
              , each as its id, publish time, data (base64), attributes and ordering key. A file
              published back from the composer publishes them again.
            </span>
          }
          formats={['ndjson', 'json']}
          filename={(format) =>
            `${topicId}-${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'json' : 'ndjson'}`
          }
          href={(format) =>
            messagesExportUrl({
              topic,
              ...(q ? { q } : {}),
              ...(expr ? { expr } : {}),
              format: format === 'json' ? 'json' : 'ndjson',
              ...(exportSelected && !ticked.everything ? { ids: [...ticked.checked] } : {}),
            })
          }
          testId="pubsub-export-dialog"
        />
      )}
    </>
  )
}

/** A message as its JSON for the clipboard: the data as what it is, base64 only when it is bytes. */
export function messageJson(message: PubsubMessageDetail) {
  let data: unknown = message.dataBase64
  if (message.dataText !== null)
    data = message.dataJson ? (JSON.parse(message.dataText) as unknown) : message.dataText
  return {
    id: message.id,
    publishTime: message.publishTime,
    data,
    ...(message.dataText === null ? { encoding: 'base64' } : {}),
    attributes: message.attributes,
    orderingKey: message.orderingKey,
  }
}
