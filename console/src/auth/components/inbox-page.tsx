// The Inbox: every email link and SMS code the emulator created — sent
// (logged, as an email would be), returned to an Admin SDK `generate…Link`
// call, or found in saved state — newest first and live, so the code the app
// is waiting for is on screen the moment it exists. The engine filters
// (`q`, the tenant) and pages; the list is the feed store the engine's
// `auth.inbox` topic fills, bounded by what the engine keeps.

import { Button, Tooltip } from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  BellIcon,
  BellSlashIcon,
  BracketsCurlyIcon,
  CheckIcon,
  CopyIcon,
  EnvelopeOpenIcon,
  PauseIcon,
  TrashIcon,
  UserIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import { statusQuery } from '@/api/queries'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { EmptyState, NoMatch, QueryError, TableSkeleton } from '@/components/console/empty-state'
import { FacetList } from '@/components/console/facet-list'
import { FeedList, useFeedPending } from '@/components/console/feed-list'
import { FilterField } from '@/components/console/filter-field'
import { LiveNotice } from '@/components/console/live-notice'
import { MatchCount } from '@/components/console/match-count'
import { PanelHeader } from '@/components/console/panel'
import { ClearHistoryButton } from '@/components/console/clear-history-button'
import { PauseButton } from '@/components/console/pause-button'
import type { RowMenuItem } from '@/components/console/row-menu'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import {
  SectionToolbar,
  ToolbarDivider,
  ToolbarRow,
  ToolbarScope,
} from '@/components/console/toolbar'
import { PanelToggle, SectionPanel } from '@/components/shell/section-panel'
import { panelShown, useLayout } from '@/lib/layout'
import { unseenCount, useSeen } from '@/lib/badges'
import { formatNumber } from '@/lib/format'
import { liveChannel } from '@/lib/live/channel'
import { useBadges } from '@/lib/live/shell'
import { useConsoleProject } from '@/lib/project'
import { useRouteSearch } from '@/lib/search-params'
import { useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { clearMessages } from '../api'
import { copyToClipboard } from '@/lib/copy'
import { MESSAGE_FIELDS, messageFacetGroups } from '../fields'
import { userLink } from '../links'
import { useInboxFeed } from '../live'
import {
  actionBlocked,
  applyCode,
  isSms,
  messageAction,
  messageJson,
  messageLabel,
  openHref,
  primaryValue,
  useToastsOn,
} from '../messages'
import { MESSAGE_CAPACITY, authKeys, newestMessageQuery, summaryQuery } from '../queries'
import { type TenantScope, tenantKey, tenantParam, tenantScope } from '../tenant-scope'
import { FeedFooter, useItemCount } from '@/components/console/feed-footer'
import { useFeedItem, useFeedMenu, useFeedNeighbours } from './feed-menu'
import { MessageReader } from './message-reader'
import { MessageRow } from './message-row'
import { usePagePalette } from './page-palette'
import { TenantPicker, scopeLabel } from './tenant-picker'

/** The Inbox's search params (`routes/auth_.inbox.tsx`). */
export type InboxSearch = {
  project?: string | undefined
  tenant?: string | undefined
  q?: string | undefined
  message?: number | undefined
  paused?: boolean | undefined
}

const NOUN = { one: 'message', other: 'messages' }
/** How long the filter waits after the last key before the address (and the engine) follows, ms. */
const FILTER_SETTLE_MS = 250

const messageKey = (message: AuthMessage) => String(message.id)

/**
 * Where the unread dots start: the badge's growth since this browser last
 * looked (`unseen`), counted down from the project's newest message id. For
 * another project than the emulator's own the badge counted other messages,
 * so only what arrives from here on is new there.
 */
export function unreadBoundary(options: {
  newest: number
  unseen: number
  project: string
  configured: string | undefined
}): number {
  const counted =
    options.configured === undefined || options.project === options.configured ? options.unseen : 0
  return Math.max(0, options.newest - counted)
}

/**
 * The boundary for this page: the seen record taken as the page opens,
 * before the page marks the badge seen; the badge itself may arrive a moment
 * later on a fresh load, and what it counts by then (the messages since the
 * last look, and any that came meanwhile) is what is new.
 */
function useUnreadBoundary(
  project: string,
  configured: string | undefined,
  instance: string | undefined,
): number | undefined {
  const [seen] = useState(() =>
    configured ? useSeen.getState().seen[configured]?.['auth.inbox'] : undefined,
  )
  const badge = useBadges((state) => state.badges.get('auth.inbox'))
  const badgesKnown = useBadges((state) => state.badges.size > 0)
  const newest = useQuery({ ...newestMessageQuery(project), enabled: project !== '' })
  const [boundary, setBoundary] = useState<number | undefined>(undefined)
  if (boundary === undefined && newest.data !== undefined && (badge !== undefined || badgesKnown)) {
    const next = unreadBoundary({
      newest: newest.data,
      unseen: badge === undefined ? 0 : unseenCount(badge, seen, instance),
      project,
      configured,
    })
    setBoundary(next)
    return next
  }
  return boundary
}

export function InboxPage() {
  const { search, update } = useRouteSearch<InboxSearch>('/auth_/inbox', '/auth/inbox')
  const { project } = useConsoleProject()
  const status = useQuery(statusQuery)
  const configured = status.data?.projectId
  const scope = tenantScope('inbox', search.tenant)
  const q = search.q ?? ''
  const paused = search.paused === true
  const summary = useQuery({ ...summaryQuery(project), enabled: project !== '' })
  const capacity = summary.data?.messageCapacity ?? MESSAGE_CAPACITY
  const feed = useInboxFeed({ project, scope, q, capacity })
  const panelOpen = useLayout(panelShown)

  // The filter follows typing into the address once it settles.
  const settle = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(settle.current), [])
  const onFilter = (text: string) => {
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(
      () => update({ q: text.trim() === '' ? undefined : text }, { replace: true }),
      FILTER_SETTLE_MS,
    )
  }
  const setScope = (next: TenantScope) =>
    update({ tenant: tenantParam('inbox', next), message: undefined }, { replace: true })

  // The selected row (the keyboard's cursor) and the one open in the reader.
  const [selectedKey, setSelectedKey] = useState<string | undefined>(
    search.message === undefined ? undefined : String(search.message),
  )
  const openKey = search.message === undefined ? undefined : String(search.message)
  const pointed = useRef(false)
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set())
  const [focusPassword, setFocusPassword] = useState(0)
  const open = (message: AuthMessage) => {
    setSelectedKey(messageKey(message))
    setOpened((current) => (current.has(message.id) ? current : new Set(current).add(message.id)))
    update({ message: message.id }, { replace: search.message !== undefined })
  }
  const close = () => update({ message: undefined }, { replace: true })
  const onSelect = (message: AuthMessage) => {
    // A click opens the row; the keyboard moves the cursor, and an open
    // reader follows it.
    if (pointed.current || openKey !== undefined) open(message)
    else setSelectedKey(messageKey(message))
    pointed.current = false
  }
  const queryClient = useQueryClient()
  const retry = () =>
    void queryClient.refetchQueries({ queryKey: authKeys.messages(project, tenantKey(scope), q) })

  const boundary = useUnreadBoundary(project, configured, status.data?.instance)
  const unread = (message: AuthMessage) =>
    boundary !== undefined &&
    message.id > boundary &&
    message.delivery !== 'restored' &&
    !message.used &&
    !opened.has(message.id)

  const navigate = useNavigate()
  const openUser = (message: AuthMessage) => {
    if (!message.uid) return
    const link = userLink(message.tenant, message.uid)
    void navigate({
      to: link.to as never,
      search: { ...link.search, project: search.project } as never,
    })
  }
  const apply = useMutation({
    mutationFn: (message: AuthMessage) => applyCode(message),
    onSuccess: (_answer, message) => {
      const action = messageAction(message)
      toast({
        key: `auth.apply.${message.id}`,
        title: action.kind === 'apply' ? action.done : 'Done.',
        tone: 'success',
      })
    },
    onError: (error) =>
      toast({
        key: 'auth.apply',
        title: error instanceof Error ? error.message : 'The emulator refused it.',
        tone: 'danger',
      }),
  })
  const act = (message: AuthMessage) => {
    const action = messageAction(message)
    if (action.kind === 'copy')
      return void copyToClipboard(message.code, { what: `the code ${message.code}` })
    if (action.kind === 'open') {
      const href = openHref(message)
      if (href) window.open(href, '_blank', 'noopener')
      return
    }
    if (action.kind === 'reset') {
      open(message)
      setFocusPassword((count) => count + 1)
      return
    }
    apply.mutate(message)
  }

  const rowItems = (message: AuthMessage): RowMenuItem[] => {
    const items: RowMenuItem[] = []
    const blocked = actionBlocked(project, configured, message)
    if (isSms(message))
      items.push({
        id: 'copy-code',
        label: 'Copy code',
        icon: CopyIcon,
        shortcut: 'c',
        run: () => void copyToClipboard(message.code, { what: `the code ${message.code}` }),
      })
    else if (message.link) {
      const link = message.link
      items.push({
        id: 'copy-link',
        label: 'Copy link',
        icon: CopyIcon,
        shortcut: 'c',
        run: () => void copyToClipboard(link, { what: 'the link' }),
      })
      items.push({
        id: 'open-link',
        label: messageAction(message).kind === 'open' ? 'Open in app' : 'Open link',
        icon: ArrowSquareOutIcon,
        shortcut: 'o',
        disabled: actionBlocked(project, configured, { used: false }),
        run: () => {
          const href = openHref(message)
          if (href) window.open(href, '_blank', 'noopener')
        },
      })
    }
    const action = messageAction(message)
    if (action.kind === 'apply' || action.kind === 'reset')
      items.push({
        id: 'act',
        label: action.label,
        icon: CheckIcon,
        shortcut: 'a',
        disabled: blocked,
        run: () => act(message),
      })
    items.push({
      id: 'copy-json',
      label: 'Copy as JSON',
      icon: BracketsCurlyIcon,
      shortcut: 'Shift+c',
      run: () => void copyToClipboard(messageJson(message), { what: 'the message as JSON' }),
    })
    if (message.uid)
      items.push({
        id: 'open-user',
        label: 'Open user',
        icon: UserIcon,
        run: () => openUser(message),
      })
    return items
  }
  const menu = useFeedMenu({
    store: feed.store,
    items: rowItems,
    selectedKey,
    subject: (message) => `${messageLabel(message)} · ${message.to}`,
    scope: 'auth.inbox',
    testId: 'inbox-feed',
    onPress: () => {
      pointed.current = true
    },
  })

  const selected = useFeedItem(feed.store, selectedKey)
  const openMessage = useFeedItem(feed.store, openKey)
  const { newer, older } = useFeedNeighbours(feed.store, openKey)
  const pending = useFeedPending(feed.store, paused, messageKey)
  const setPaused = (next: boolean) => update({ paused: next || undefined }, { replace: true })
  const toastsOn = useToastsOn((state) => state.on)
  const setToasts = useToastsOn((state) => state.set)
  const [clearing, setClearing] = useState(false)

  useShortcuts({ id: 'auth.inbox', label: 'Inbox' }, [
    {
      key: 'c',
      label: 'Copy the code or link',
      group: 'Inbox',
      when: () => selected !== undefined,
      run: () => {
        if (selected)
          void copyToClipboard(primaryValue(selected), {
            what: isSms(selected) ? `the code ${selected.code}` : 'the link',
          })
      },
    },
    {
      key: 'Shift+c',
      label: 'Copy the message as JSON',
      group: 'Inbox',
      when: () => selected !== undefined,
      run: () => {
        if (selected) void copyToClipboard(messageJson(selected), { what: 'the message as JSON' })
      },
    },
    {
      key: 'a',
      label: 'Apply the code or link',
      group: 'Inbox',
      when: () =>
        selected !== undefined && actionBlocked(project, configured, selected) === undefined,
      run: () => {
        if (selected) act(selected)
      },
    },
    {
      key: 'Escape',
      label: 'Close the message',
      group: 'Inbox',
      when: () => openKey !== undefined,
      run: close,
    },
  ])

  const loaded = useItemCount(feed.store)
  usePagePalette('auth.inbox', 'Inbox', () => [
    {
      id: 'auth.inbox.pause',
      title: paused ? 'Resume the inbox' : 'Pause the inbox',
      keywords: 'pause resume follow live',
      icon: <PauseIcon size={16} />,
      run: () => setPaused(!paused),
    },
    {
      id: 'auth.inbox.toasts',
      title: toastsOn
        ? 'Turn off toasts for new codes and links'
        : 'Turn on toasts for new codes and links',
      keywords: 'toasts notifications',
      icon: toastsOn ? <BellSlashIcon size={16} /> : <BellIcon size={16} />,
      run: () => setToasts(!toastsOn),
    },
    {
      id: 'auth.inbox.clear',
      title: 'Clear the inbox history…',
      keywords: 'delete remove empty',
      icon: <TrashIcon size={16} />,
      run: () => setClearing(true),
    },
  ])

  const clear = useMutation({
    mutationFn: () => clearMessages(project),
    onSuccess: () => setClearing(false),
  })

  const groups = messageFacetGroups(feed.facets, q)
  const showTenant = scope.kind === 'all'
  const firstLoad = !feed.ready && feed.error === null
  const body = feed.error ? (
    <QueryError error={feed.error} onRetry={retry} section="auth" />
  ) : firstLoad ? (
    <TableSkeleton columns={[{ width: 280 }, { width: 160 }, { width: 140 }, { width: 120 }]} />
  ) : (
    <FeedList
      ariaLabel="Codes and links"
      store={feed.store}
      order="newest-first"
      rowHeight={32}
      rowKey={messageKey}
      renderRow={(message) => (
        <MessageRow
          message={message}
          unread={unread(message)}
          showTenant={showTenant}
          handle={menu.handle}
        />
      )}
      selectedKey={selectedKey}
      onSelect={onSelect}
      onOpenTarget={(message) => {
        const href = openHref(message)
        if (href && !actionBlocked(project, configured, { used: false }))
          window.open(href, '_blank', 'noopener')
      }}
      follow={!paused}
      onFollowChange={(follow) => setPaused(!follow)}
      hasMore={feed.hasOlder}
      loadMore={feed.loadOlder}
      scrollToKey={openKey === undefined ? undefined : { key: openKey }}
      empty={
        q === '' ? (
          <EmptyState
            icon={EnvelopeOpenIcon}
            title="Nothing sent yet"
            description="When your app sends a verification email, a password reset, a sign-in link or an SMS code, it lands here — the emulator never sends real email or SMS."
            testId="inbox-empty"
          />
        ) : (
          <NoMatch
            filter={q}
            noun="messages"
            onClear={() => update({ q: undefined }, { replace: true })}
          />
        )
      }
      testId="inbox-feed"
    />
  )

  return (
    <SectionPage section="auth" page="inbox" title="Inbox" testId="auth-inbox">
      <SectionPanel label="Filters">
        <PanelHeader>
          <div className="min-w-0 flex-1">
            <TenantPicker project={project} page="inbox" scope={scope} onChange={setScope} />
          </div>
        </PanelHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-3" data-testid="inbox-facets">
          <FacetList
            groups={groups}
            value={q}
            onChange={(next) => update({ q: next || undefined }, { replace: true })}
          />
        </div>
      </SectionPanel>
      <SectionToolbar>
        <ToolbarRow testId="inbox-row-one">
          <PanelToggle where="toolbar" />
          {!panelOpen && (
            <div className="w-56 min-w-0 shrink" data-testid="toolbar-tenant">
              <TenantPicker
                project={project}
                page="inbox"
                scope={scope}
                onChange={setScope}
                testId="toolbar-tenant-picker"
              />
            </div>
          )}
          {panelOpen && (
            <ToolbarScope detail={scopeLabel(scope)} testId="toolbar-scope">
              Inbox
            </ToolbarScope>
          )}
          <span className="min-w-0 flex-1" />
          <LiveNotice status={feed.status} what="the inbox" onRetry={() => liveChannel.retry()} />
          <ToolbarDivider />
          <Tooltip
            content={
              toastsOn
                ? 'A toast for each new code or link your app causes, wherever you are in the console'
                : 'No toasts for new codes and links; the Inbox still counts them'
            }
            render={
              <Button
                variant={toastsOn ? 'secondary' : 'ghost'}
                size="sm"
                icon={toastsOn ? <BellIcon /> : <BellSlashIcon />}
                aria-pressed={toastsOn}
                onClick={() => setToasts(!toastsOn)}
                data-testid="inbox-toasts"
              >
                Toasts
              </Button>
            }
          />
          <ClearHistoryButton
            onClick={() => setClearing(true)}
            disabled={loaded === 0}
            testId="inbox-clear"
          />
        </ToolbarRow>
        <ToolbarRow variant="line" testId="inbox-row-two">
          <FilterField
            value={q}
            onChange={onFilter}
            fields={MESSAGE_FIELDS}
            placeholder="Filter messages — -is:used type:sms kind:reset ada@"
            ariaLabel="Filter messages"
            testId="inbox-filter"
          />
          <MatchCount
            total={feed.page?.total ?? undefined}
            noun={NOUN}
            widest="00,000 messages"
            loading={firstLoad}
            hidden={feed.error !== null}
            tooltip="Every message this filter matches among those the engine keeps, not only the rows loaded."
          />
          <PauseButton paused={paused} pending={pending} onChange={setPaused} />
        </ToolbarRow>
      </SectionToolbar>
      <SectionBody>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {body}
          {feed.ready && feed.error === null && loaded > 0 && (
            <FeedFooter loaded={loaded} capacity={capacity} noun={NOUN} testId="inbox-footer" />
          )}
        </div>
        {openKey !== undefined && search.message !== undefined && (
          <MessageReader
            project={project}
            id={search.message}
            loaded={openMessage}
            capacity={capacity}
            focusPassword={focusPassword}
            onClose={close}
            onPrev={newer ? () => open(newer) : undefined}
            onNext={older ? () => open(older) : undefined}
          />
        )}
      </SectionBody>
      {menu.popup}
      <DangerConfirm
        open={clearing}
        onOpenChange={setClearing}
        title="Clear the inbox history"
        description={`Removes ${loaded === 1 ? 'this message' : `these ${formatNumber(loaded)} messages`} from the console's list.`}
        consequences={['Codes already sent still work until used.']}
        pending={clear.isPending}
        {...(clear.error instanceof Error ? { error: clear.error.message } : {})}
        onConfirm={() => clear.mutate()}
        testId="inbox-clear-confirm"
      />
    </SectionPage>
  )
}
