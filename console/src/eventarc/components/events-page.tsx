// Eventarc's events page: every event on every channel (or one, picked in
// the panel), live, filtered in the engine, each with what became of it;
// the delivery trace of the one open; and the publish drawer, with a
// preview of who an event would reach before it is sent. Replay and edit
// run again what the engine kept.

import { Button, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  BracketsCurlyIcon,
  CopyIcon,
  LightningIcon,
  PaperPlaneTiltIcon,
  PencilSimpleIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ApiError } from '@/api/client'
import type { EventarcEventSummary } from '@/api/generated/compute/EventarcEventSummary'
import type { EventarcEventView } from '@/api/generated/compute/EventarcEventView'
import { statusQuery } from '@/api/queries'
import { QueryError } from '@/components/console/empty-state'
import { FilterField } from '@/components/console/filter-field'
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
import { ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { CopyButton } from '@/components/console/copy-button'
import { PanelToggle } from '@/components/shell/section-panel'
import { Kbd } from '@/components/kit'
import { EVENT_LIST } from '@/compute/event-row'
import { ReplayConfirm } from '@/compute/replay-confirm'
import { useSeededPending } from '@/compute/seeded-pending'
import { linkTo } from '@/lib/links'
import { useFunctionsEvents } from '@/functions/live'
import { type SubscriptionStatus, liveChannel } from '@/lib/live/channel'
import { useRouteSearch } from '@/lib/search-params'
import { useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { channelsQuery, eventQuery, eventarcKeys, publishEvent, replayEvent } from '../api'
import { eventFields, toggleFailed } from '../filters'
import { useEventarcPalette } from '../palette'
import { type PublishDraft, draftFromEvent, emptyDraft, publishRequest } from '../publish'
import type { EventsSearch } from '../search'
import { channelLabel, channelNamed, knownTypes } from '../topology'
import { ChannelsPanel } from './channels-panel'
import { EventDetail, eventFigure } from './event-detail'
import { EventList, useEventFeed, useNeighbours } from './event-list'
import { PublishDrawer } from './publish-drawer'

/** Copies an event's id, and says so. */
function copyId(id: string) {
  void navigator.clipboard
    .writeText(id)
    .then(() => toast({ key: 'eventarc.copy', title: `Copied ${id}`, tone: 'success' }))
}

/** Whether this page's subscription stopped, so `LiveNotice` has something to say. */
function stopped(status: SubscriptionStatus): boolean {
  return status === 'ended' || status === 'refused'
}

/** An engine refusal as the drawer and dialogs say it. */
function refusal(error: unknown): { message: string; fix?: string | undefined } | undefined {
  if (!error) return undefined
  if (error instanceof ApiError) return { message: error.message, fix: error.fix }
  return { message: error instanceof Error ? error.message : String(error) }
}

/** `functions.events` for inventory changes only: no rows, no figures. */
const INVENTORY = { changesOnly: true } as const

/** An event's row key. */
const eventKey = (event: { id: string }) => event.id

export function EventsPage() {
  const { search, update } = useRouteSearch<EventsSearch>('/eventarc', '/eventarc')
  const project = useQuery(statusQuery).data?.projectId ?? ''
  const client = useQueryClient()
  const navigate = useNavigate()
  const channels = useQuery(channelsQuery(project))
  // A reload in Functions can change who listens: its inventory changes refresh the channels.
  useFunctionsEvents(INVENTORY, { toasts: false })
  const channel = search.channel ?? ''
  const q = search.q ?? ''
  const scope = channels.data
    ? channelNamed(channels.data.channels, channels.data.native, channel)
    : undefined
  const feed = useEventFeed(project, channel, q)
  const paused = search.paused === true
  const pending = useSeededPending(feed.store, paused, eventKey, feed.total?.count)

  // The drawer's draft lives here, so closing and reopening it keeps it.
  const [draft, setDraft] = useState<PublishDraft>(() => emptyDraft(channel))
  const drawerOpen = search.new === 'event'
  // The channel a fresh draft starts on: the one in scope, else the first in use.
  const defaultChannel = channel !== '' ? channel : (channels.data?.channels[0]?.name ?? '')
  const openDrawer = (next?: PublishDraft) => {
    if (next) setDraft(next)
    else if (draft.channel === '' && defaultChannel !== '')
      setDraft({ ...draft, channel: defaultChannel })
    update({ new: 'event', event: undefined })
  }
  // A drawer opened by its link (⌘K, `n`, a bookmark) starts on that channel too, once.
  const [placed, setPlaced] = useState(false)
  if (drawerOpen && !placed && draft.channel === '' && defaultChannel !== '') {
    setPlaced(true)
    setDraft({ ...draft, channel: defaultChannel })
  }
  // Edit and publish from a link: the drawer filled from the event once it
  // is read, then the param is dropped from the address.
  const prefill = useQuery({
    ...eventQuery(project, search.prefill ?? ''),
    enabled: search.prefill !== undefined,
  })
  const [prefilled, setPrefilled] = useState<string | undefined>(undefined)
  if (prefill.data && search.prefill !== undefined && prefilled !== search.prefill) {
    setPrefilled(search.prefill)
    setDraft(draftFromEvent(prefill.data))
  }
  useEffect(() => {
    if (prefilled !== undefined && search.prefill === prefilled)
      update({ prefill: undefined, new: 'event' }, { replace: true })
  }, [prefilled, search.prefill, update])

  const publish = useMutation({
    mutationFn: () => publishEvent(publishRequest(draft)),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: eventarcKeys.channels(project) })
      toast({
        key: 'eventarc.published',
        title: `Published ${eventFigure(result.event.id)}`,
        description: result.event.unheard
          ? `No function listens for ${result.event.eventType} on that channel.`
          : `${result.event.matched} ${result.event.matched === 1 ? 'trigger matches' : 'triggers match'} it.`,
        tone: result.event.unheard ? 'warning' : 'success',
      })
      update({ new: undefined, event: result.event.id })
    },
  })

  const [keepId, setKeepId] = useState(false)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const replay = useMutation({
    mutationFn: (id: string) => replayEvent(id, { keepId }),
    onSuccess: (result) => {
      setConfirming(undefined)
      toast({
        key: 'eventarc.replayed',
        title: `Published ${eventFigure(result.event.id)} again`,
        tone: 'success',
      })
      update({ event: result.event.id })
    },
  })

  const select = (event: EventarcEventSummary) => update({ event: event.id, new: undefined })
  /** The first delivered invocation, read from the event's trace, opened in Functions. */
  const openTarget = (id: string) => {
    void client.fetchQuery(eventQuery(project, id)).then((view) => {
      const index = view.detail.deliveries.findIndex((delivery) => delivery.invocationId !== null)
      const ref = index === -1 ? undefined : view.deliveries[index]?.invocation
      const link = ref ? linkTo(ref) : null
      if (link) void navigate({ to: link.to as never, search: link.search as never })
      else
        toast({
          key: 'eventarc.target',
          title:
            index === -1
              ? 'No function ran for this event.'
              : 'Its invocation opens in Functions once that section is built.',
        })
    })
  }
  const editFrom = (view: EventarcEventView, type?: string) =>
    openDrawer({ ...draftFromEvent(view), ...(type ? { type } : {}) })
  const editById = (id: string) =>
    void client.fetchQuery(eventQuery(project, id)).then((view) => editFrom(view))
  const copyJson = (id: string) =>
    void client
      .fetchQuery(eventQuery(project, id))
      .then((view) => navigator.clipboard.writeText(JSON.stringify(view.detail, null, 2)))
      .then(() =>
        toast({ key: 'eventarc.copy', title: 'Copied the event as JSON', tone: 'success' }),
      )

  /** One event's actions: its row's menu (right-click, Shift+F10), ⌘K, and the keys. */
  const rowItems = (id: string): RowMenuItem[] => [
    {
      id: 'open',
      label: 'Open',
      icon: ArrowSquareOutIcon,
      shortcut: 'Enter',
      run: () => update({ event: id, new: undefined }),
    },
    {
      id: 'replay',
      label: 'Replay…',
      icon: ArrowCounterClockwiseIcon,
      shortcut: 'r',
      run: () => {
        update({ event: id, new: undefined })
        setConfirming(id)
      },
    },
    {
      id: 'edit',
      label: 'Edit and publish',
      icon: PencilSimpleIcon,
      shortcut: 'Shift+R',
      run: () => editById(id),
    },
    {
      id: 'target',
      label: 'Open the first delivered invocation',
      icon: LightningIcon,
      shortcut: 'o',
      run: () => openTarget(id),
    },
    { id: 'copy', label: 'Copy the id', icon: CopyIcon, shortcut: 'c', run: () => copyId(id) },
    {
      id: 'json',
      label: 'Copy as JSON',
      icon: BracketsCurlyIcon,
      shortcut: 'Shift+C',
      run: () => copyJson(id),
    },
  ]
  const [menu, setMenu] = useState<{ id: string; anchor: RowMenuAnchor } | null>(null)
  const openMenuAt = (target: EventTarget, at: { x: number; y: number } | undefined) => {
    const element = target instanceof Element ? target.closest('[data-key]') : null
    const id = element?.getAttribute('data-key')
    if (!element || !id) return false
    setMenu({ id, anchor: at ?? element })
    return true
  }

  // The rows around the open one, for the inspector's ↑ ↓ (newest first).
  const { newer, older } = useNeighbours(feed.store, search.event)

  const selected = search.event
  const selectedItems = selected === undefined ? undefined : rowItems(selected)
  useRowMenuPalette(selectedItems, selected ? `Event ${eventFigure(selected)}` : undefined)
  const run = (item: string) => selectedItems?.find((entry) => entry.id === item)?.run()
  useShortcuts({ id: 'eventarc.events', label: 'Eventarc events' }, [
    { key: 'n', label: 'Publish an event', run: () => openDrawer() },
    {
      key: 'e',
      label: 'Failed deliveries only',
      run: () => update({ q: toggleFailed(q) }, { replace: true }),
    },
    {
      key: 'r',
      label: 'Publish the event again',
      when: () => selected !== undefined && !drawerOpen,
      run: () => run('replay'),
    },
    {
      key: 'Shift+R',
      label: 'Edit the event, then publish it',
      when: () => selected !== undefined,
      run: () => run('edit'),
    },
    {
      key: 'c',
      label: 'Copy the event id',
      when: () => selected !== undefined,
      run: () => run('copy'),
    },
    {
      key: 'Shift+C',
      label: 'Copy the event as JSON',
      when: () => selected !== undefined,
      run: () => run('json'),
    },
    {
      key: 'Shift+F10',
      label: "The event's menu",
      when: () => selected !== undefined,
      run: () => {
        const row = document.querySelector(
          `[data-testid="feed-row"][data-key="${CSS.escape(selected ?? '')}"]`,
        )
        if (row && selected) setMenu({ id: selected, anchor: row })
      },
    },
  ])

  useEventarcPalette(channels.data, {
    publish: () => openDrawer(),
    scope: (name) => update({ channel: name, event: undefined }),
    channelsPage: () => void navigate({ to: '/eventarc/channels' }),
  })

  const label = scope ? channelLabel(scope) : undefined
  const fields = eventFields(() =>
    channels.data ? knownTypes([...channels.data.channels, channels.data.native]) : [],
  )
  return (
    <SectionPage section="eventarc" page="events" title="Eventarc events" testId="eventarc-events">
      <ChannelsPanel
        snapshot={channels.data}
        current={search.channel}
        onOpen={(name) => update({ channel: name, event: undefined })}
      />
      <ToolbarRow testId="events-toolbar">
        <PanelToggle where="toolbar" />
        <span
          className="flex min-w-0 flex-1 items-baseline gap-2 px-1 text-[12px]"
          data-testid="events-scope"
        >
          {search.channel === undefined ? (
            <span className="font-medium text-kumo-default">All channels</span>
          ) : (
            <>
              <span className="shrink-0 font-mono font-medium text-kumo-default">
                {label?.id ?? search.channel}
              </span>
              {label?.where && <span className="shrink-0 text-kumo-subtle">{label.where}</span>}
              <Tooltip
                content={search.channel}
                render={
                  <span className="min-w-0 truncate font-mono text-kumo-subtle">
                    {search.channel}
                  </span>
                }
              />
              <CopyButton value={search.channel} label="Copy the channel" />
            </>
          )}
        </span>
        {stopped(feed.live) && (
          <>
            <ToolbarDivider />
            <LiveNotice status={feed.live} what="the events" onRetry={() => liveChannel.retry()} />
          </>
        )}
        <ToolbarDivider />
        <Tooltip
          content={
            <span className="flex items-center gap-1.5">
              Publish a custom event on a channel
              <Kbd>n</Kbd>
            </span>
          }
          render={
            <Button
              variant={drawerOpen ? 'secondary' : 'primary'}
              size="sm"
              icon={<PaperPlaneTiltIcon />}
              onClick={() => openDrawer()}
              className="shrink-0"
              data-primary={drawerOpen ? undefined : ''}
              data-testid="events-publish"
            >
              Publish event
            </Button>
          }
        />
      </ToolbarRow>
      <ToolbarRow variant="line" testId="events-filter-row">
        <FilterField
          value={q}
          onChange={(text) => update({ q: text, event: undefined }, { replace: true })}
          fields={fields}
          placeholder="Filter events — type:test.greeter.* delivery:filtered subject:greetings/ada"
          ariaLabel="Filter events"
          testId="events-filter"
        />
        <MatchCount
          total={feed.total}
          loading={feed.page.isPending}
          noun={{ one: 'event', other: 'events' }}
          widest="0,000"
          tooltip={
            feed.total && !feed.total.exact
              ? 'The engine keeps the newest 1,000 events.'
              : 'Every event the engine keeps that this filter matches.'
          }
        />
        <PauseButton
          paused={paused}
          pending={pending}
          onChange={(next) => update({ paused: next || undefined }, { replace: true })}
        />
      </ToolbarRow>
      <SectionBody testId="events-body">
        <div
          className={EVENT_LIST}
          onContextMenu={(event) => {
            if (openMenuAt(event.target, { x: event.clientX, y: event.clientY }))
              event.preventDefault()
          }}
        >
          <EventList
            store={feed.store}
            loading={feed.page.isPending}
            failed={
              feed.page.isError ? (
                <QueryError
                  error={feed.page.error}
                  onRetry={() => void feed.page.refetch()}
                  section="eventarc"
                />
              ) : null
            }
            q={q}
            onClearFilter={() => update({ q: undefined }, { replace: true })}
            channelName={search.channel}
            selected={search.event}
            onSelect={select}
            onOpenTarget={(event) => openTarget(event.id)}
            follow={!paused}
            onFollowChange={(follow) =>
              update({ paused: follow ? undefined : true }, { replace: true })
            }
            hasMore={feed.hasMore}
            loadMore={feed.loadOlder}
            onPublish={() => openDrawer()}
          />
        </div>
        <RowMenuPopup
          items={menu ? rowItems(menu.id) : []}
          open={menu !== null}
          onOpenChange={(open) => {
            if (!open) setMenu(null)
          }}
          anchor={menu?.anchor ?? null}
          testId="event-row-menu"
        />
        {drawerOpen ? (
          <PublishDrawer
            project={project}
            draft={draft}
            onChange={(next) => {
              setDraft(next)
              if (publish.error) publish.reset()
            }}
            channels={channels.data}
            pending={publish.isPending}
            error={refusal(publish.error)}
            onPublish={() => publish.mutate()}
            onClose={() => update({ new: undefined })}
          />
        ) : search.event ? (
          <EventDetail
            project={project}
            id={search.event}
            channels={channels.data}
            keepId={keepId}
            onKeepIdChange={setKeepId}
            replaying={replay.isPending && confirming === undefined}
            onReplay={() => {
              if (search.event) replay.mutate(search.event)
            }}
            onEdit={() => {
              if (search.event) editById(search.event)
            }}
            onUseType={(view, type) => editFrom(view, type)}
            onClose={() => update({ event: undefined })}
            onPrev={newer ? () => update({ event: newer }, { replace: true }) : undefined}
            onNext={older ? () => update({ event: older }, { replace: true }) : undefined}
          />
        ) : null}
      </SectionBody>
      <ReplayConfirm
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(undefined)
            replay.reset()
          }
        }}
        title={
          confirming
            ? keepId
              ? `Publish event ${eventFigure(confirming)} again with its own id?`
              : `Publish event ${eventFigure(confirming)} again with a new id?`
            : 'Publish the event again?'
        }
        description="It goes out on its channel as before, and every trigger that listens for it runs again; whatever they write is written again."
        option={{ label: 'Keep the id', checked: keepId, onChange: setKeepId }}
        pending={replay.isPending}
        error={refusal(replay.error)?.message}
        onConfirm={() => {
          if (confirming) replay.mutate(confirming)
        }}
        testId="event-replay-confirm"
      />
    </SectionPage>
  )
}
