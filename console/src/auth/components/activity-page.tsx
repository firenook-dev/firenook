// Activity: every call to the Auth emulator — from the app, the Admin SDK,
// an action link, the account picker, the console itself — newest first and
// live, each with how it ended in the words the SDK will use, what it caused
// and how long it took. The engine filters (`q`, the tenant, the console's
// own edits) and pages; the list is the feed store `auth.activity` fills,
// bounded by what the engine keeps. A call opens into the detail; the side
// panel holds the tools (Inspect a token).

import { Button, Checkbox } from '@cloudflare/kumo'
import {
  ArrowClockwiseIcon,
  BracketsCurlyIcon,
  FileTextIcon,
  FunnelIcon,
  LightningIcon,
  ListMagnifyingGlassIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  TerminalWindowIcon,
  TrashIcon,
  UserIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { AuthActivityDetail } from '@/api/generated/auth/AuthActivityDetail'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { EmptyState, NoMatch, QueryError, TableSkeleton } from '@/components/console/empty-state'
import { FacetList, toggleFacet } from '@/components/console/facet-list'
import { FeedList, useFeedPending } from '@/components/console/feed-list'
import { FilterField } from '@/components/console/filter-field'
import { LiveNotice } from '@/components/console/live-notice'
import { MatchCount } from '@/components/console/match-count'
import { PanelHeader } from '@/components/console/panel'
import { PauseButton } from '@/components/console/pause-button'
import type { RowMenuItem } from '@/components/console/row-menu'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import { SectionToolbar, ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { PanelToggle, SectionPanel } from '@/components/shell/section-panel'
import { formatNumber } from '@/lib/format'
import { useLayout } from '@/lib/layout'
import { linkTo } from '@/lib/links'
import { liveChannel } from '@/lib/live/channel'
import { useConsoleProject } from '@/lib/project'
import { useRouteSearch } from '@/lib/search-params'
import { sectionById } from '@/lib/services'
import { useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { callJson, curlCommand, replayBlocked, tokenOfRequest } from '../activity'
import { clearActivity } from '../api'
import { copyWithToast } from '../clipboard'
import { activityFacetGroups, activityFields } from '../fields'
import { inspectThisToken } from '../inspect-draft'
import { logsForCall, userLink } from '../links'
import { useActivityFeed } from '../live'
import { callLabel } from '../operations'
import { ACTIVITY_CAPACITY, activityEntryQuery, authKeys, summaryQuery } from '../queries'
import { type TenantScope, tenantKey, tenantParam, tenantScope } from '../tenant-scope'
import { ActivityDetail, useAuthBase, useReplay } from './activity-detail'
import { ActivityRow } from './activity-row'
import { FeedFooter, useItemCount } from './feed-footer'
import { useFeedItem, useFeedMenu, useFeedNeighbours } from './feed-menu'
import { InspectToken } from './inspect-token'
import { usePagePalette } from './page-palette'
import { TenantPicker } from './tenant-picker'

/** Activity's search params (`routes/auth_.activity.tsx`). */
export type ActivitySearch = {
  project?: string | undefined
  tenant?: string | undefined
  q?: string | undefined
  entry?: number | undefined
  console?: boolean | undefined
  paused?: boolean | undefined
  panel?: 'inspect' | undefined
}

const NOUN = { one: 'call', other: 'calls' }
/** How long the filter waits after the last key before the address (and the engine) follows, ms. */
const FILTER_SETTLE_MS = 250
const ERRORS = 'is:error'

const callKey = (call: AuthActivitySummary) => String(call.id)

/** Calls whose request carries a token to inspect: an ID token, a refresh token, a custom token. */
export function mayCarryToken(call: Pick<AuthActivitySummary, 'operation' | 'caller'>): boolean {
  const operation = call.operation
  if (operation === 'securetoken.token') return true
  if (/(createSessionCookie|signInWithCustomToken)$/.test(operation)) return true
  if (call.caller !== 'client') return false
  return /\.(lookup|update|delete|sendOobCode|mfaEnrollment\.\w+|passkeyEnrollment\.\w+)$/.test(
    operation,
  )
}

/** Whether a section's pages are in this console, so a link into it goes somewhere. */
function shown(section: string): boolean {
  return sectionById(section)?.built === true
}

export function ActivityPage() {
  const { search, update } = useRouteSearch<ActivitySearch>('/auth_/activity', '/auth/activity')
  const { project } = useConsoleProject()
  const scope = tenantScope('activity', search.tenant)
  const q = search.q ?? ''
  const paused = search.paused === true
  const includeConsole = search.console === true
  const summary = useQuery({ ...summaryQuery(project), enabled: project !== '' })
  const capacity = summary.data?.activityCapacity ?? ACTIVITY_CAPACITY
  const feed = useActivityFeed({ project, scope, q, includeConsole, capacity })
  const panelOpen = useLayout((state) => state.panelOpen)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const settle = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(settle.current), [])
  const onFilter = (text: string) => {
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(
      () => update({ q: text.trim() === '' ? undefined : text }, { replace: true }),
      FILTER_SETTLE_MS,
    )
  }
  const setQ = (next: string) =>
    update({ q: next.trim() === '' ? undefined : next }, { replace: true })
  const setScope = (next: TenantScope) =>
    update({ tenant: tenantParam('activity', next), entry: undefined }, { replace: true })
  const retry = () =>
    void queryClient.refetchQueries({
      queryKey: authKeys.activity(project, tenantKey(scope), q, includeConsole),
    })

  // The selected row (the keyboard's cursor) and the call open in the detail.
  const [selectedKey, setSelectedKey] = useState<string | undefined>(
    search.entry === undefined ? undefined : String(search.entry),
  )
  const openKey = search.entry === undefined ? undefined : String(search.entry)
  const pointed = useRef(false)
  const openId = (id: number) => {
    setSelectedKey(String(id))
    update({ entry: id, panel: undefined }, { replace: search.entry !== undefined })
  }
  const open = (call: AuthActivitySummary) => openId(call.id)
  const close = () => update({ entry: undefined, panel: undefined }, { replace: true })
  const onSelect = (call: AuthActivitySummary) => {
    if (pointed.current || openKey !== undefined) open(call)
    else setSelectedKey(callKey(call))
    pointed.current = false
  }

  const navigateTo = (link: { to: string; search?: Record<string, unknown> | undefined }) =>
    void navigate({ to: link.to as never, search: link.search as never })
  const openUser = (call: AuthActivitySummary) => {
    if (!call.uid) return
    const link = userLink(call.tenant, call.uid)
    navigateTo({ ...link, search: { ...link.search, project: search.project } })
  }
  const logs = shown('logs')
    ? (call: AuthActivitySummary) => navigateTo(logsForCall(call))
    : undefined
  const inspect = (token?: string) => {
    if (token) inspectThisToken(token)
    update({ panel: 'inspect', entry: undefined })
  }

  const detailOf = (call: AuthActivitySummary): Promise<AuthActivityDetail> =>
    queryClient.fetchQuery(activityEntryQuery(project, call.id))
  const base = useAuthBase()
  const copyCurl = async (call: AuthActivitySummary) => {
    if (!base) return
    try {
      await copyWithToast(curlCommand(await detailOf(call), base), 'the call as curl')
    } catch (error) {
      toast({
        key: 'auth.curl',
        title: error instanceof Error ? error.message : 'The call could not be read.',
        tone: 'danger',
      })
    }
  }
  const replay = useReplay(openId)
  // Bumped to make the open call's detail ask before a replay that is not idempotent.
  const [replayAsk, setReplayAsk] = useState(0)
  const replayCall = async (call: AuthActivitySummary) => {
    let detail: AuthActivityDetail
    try {
      detail = await detailOf(call)
    } catch (error) {
      toast({
        key: 'auth.replay',
        title: error instanceof Error ? error.message : 'The call could not be read.',
        tone: 'danger',
      })
      return
    }
    const blocked = replayBlocked(detail, feed.bodiesRetained)
    if (blocked) {
      toast({ key: 'auth.replay', title: blocked, tone: 'warning' })
      return
    }
    if (detail.replayEffect) {
      open(call)
      setReplayAsk((count) => count + 1)
      return
    }
    replay.mutate(detail)
  }
  const inspectCall = async (call: AuthActivitySummary) => {
    try {
      const token = tokenOfRequest(await detailOf(call))
      if (token) inspect(token)
      else toast({ key: 'auth.inspect', title: 'This call carried no token.', tone: 'info' })
    } catch (error) {
      toast({
        key: 'auth.inspect',
        title: error instanceof Error ? error.message : 'The call could not be read.',
        tone: 'danger',
      })
    }
  }

  const rowItems = (call: AuthActivitySummary): RowMenuItem[] => {
    const items: RowMenuItem[] = [
      {
        id: 'open',
        label: 'Open',
        icon: ListMagnifyingGlassIcon,
        shortcut: 'Enter',
        run: () => open(call),
      },
      {
        id: 'curl',
        label: 'Copy as curl',
        icon: TerminalWindowIcon,
        disabled:
          feed.bodiesRetained === false
            ? 'Request bodies are not kept: the engine runs with --no-diagnostics.'
            : undefined,
        run: () => void copyCurl(call),
      },
      {
        id: 'replay',
        label: 'Replay',
        icon: ArrowClockwiseIcon,
        shortcut: 'r',
        disabled:
          feed.bodiesRetained === false
            ? 'Request bodies are not kept: the engine runs with --no-diagnostics.'
            : undefined,
        run: () => void replayCall(call),
      },
    ]
    if (mayCarryToken(call))
      items.push({
        id: 'inspect',
        label: 'Inspect this token',
        icon: MagnifyingGlassIcon,
        run: () => void inspectCall(call),
      })
    if (call.uid)
      items.push({ id: 'open-user', label: 'Open user', icon: UserIcon, run: () => openUser(call) })
    for (const step of call.steps) {
      if (step.kind !== 'blocking' || !step.invocation) continue
      const link = linkTo({ kind: 'functions.invocation', key: step.invocation })
      if (link)
        items.push({
          id: 'invocation',
          label: 'Open the invocation',
          icon: LightningIcon,
          run: () => navigateTo(link),
        })
      break
    }
    if (logs)
      items.push({
        id: 'logs',
        label: 'Open in Logs',
        icon: FileTextIcon,
        shortcut: 'l',
        run: () => logs(call),
      })
    items.push({
      id: 'copy-json',
      label: 'Copy as JSON',
      icon: BracketsCurlyIcon,
      shortcut: 'Shift+c',
      run: () => void copyWithToast(callJson(call), 'the call as JSON'),
    })
    return items
  }
  const menu = useFeedMenu({
    store: feed.store,
    items: rowItems,
    selectedKey,
    subject: (call) => `${callLabel(call)} · #${call.id}`,
    scope: 'auth.activity',
    testId: 'activity-feed',
    onPress: () => {
      pointed.current = true
    },
  })

  const selected = useFeedItem(feed.store, selectedKey)
  const openCall = useFeedItem(feed.store, openKey)
  const { newer, older } = useFeedNeighbours(feed.store, openKey)
  const pending = useFeedPending(feed.store, paused, callKey)
  const setPaused = (next: boolean) => update({ paused: next || undefined }, { replace: true })
  const [clearing, setClearing] = useState(false)
  const target = openCall ?? selected

  useShortcuts({ id: 'auth.activity', label: 'Activity' }, [
    {
      key: 'e',
      label: 'Errors only',
      group: 'Activity',
      run: () => setQ(toggleFacet(q, ERRORS)),
    },
    {
      key: 'c',
      label: 'Copy the identifier',
      group: 'Activity',
      when: () => selected !== undefined && (selected.identifier ?? selected.uid) !== null,
      run: () => {
        const text = selected?.identifier ?? selected?.uid
        if (text) void copyWithToast(text, text)
      },
    },
    {
      key: 'Shift+c',
      label: 'Copy the call as JSON',
      group: 'Activity',
      when: () => selected !== undefined,
      run: () => {
        if (selected) void copyWithToast(callJson(selected), 'the call as JSON')
      },
    },
    {
      key: 'r',
      label: 'Replay the call',
      group: 'Activity',
      when: () => target !== undefined && feed.bodiesRetained !== false,
      run: () => {
        if (target) void replayCall(target)
      },
    },
    {
      key: 'l',
      label: 'Open in Logs',
      group: 'Activity',
      when: () => target !== undefined && logs !== undefined,
      run: () => {
        if (target) logs?.(target)
      },
    },
    {
      key: 'Escape',
      label: 'Close the detail',
      group: 'Activity',
      when: () => openKey !== undefined || search.panel !== undefined,
      run: close,
    },
  ])

  const loaded = useItemCount(feed.store)
  usePagePalette('auth.activity', 'Activity', () => [
    {
      id: 'auth.activity.pause',
      title: paused ? 'Resume the activity' : 'Pause the activity',
      keywords: 'pause resume follow live',
      icon: <PauseIcon size={16} />,
      run: () => setPaused(!paused),
    },
    {
      id: 'auth.activity.errors',
      title: 'Errors only',
      keywords: 'failed is:error',
      icon: <FunnelIcon size={16} />,
      run: () => setQ(toggleFacet(q, ERRORS)),
    },
    {
      id: 'auth.activity.clear',
      title: 'Clear the activity history…',
      keywords: 'delete remove empty',
      icon: <TrashIcon size={16} />,
      run: () => setClearing(true),
    },
  ])

  const clear = useMutation({
    mutationFn: () => clearActivity(project),
    onSuccess: () => setClearing(false),
  })

  const firstLoad = !feed.ready && feed.error === null
  const body = feed.error ? (
    <QueryError error={feed.error} onRetry={retry} section="auth" />
  ) : firstLoad ? (
    <TableSkeleton
      columns={[{ width: 100 }, { width: 70 }, { width: 200 }, { width: 200 }, { width: 160 }]}
    />
  ) : (
    <FeedList
      ariaLabel="Calls to the Auth emulator"
      store={feed.store}
      order="newest-first"
      rowHeight={32}
      rowKey={callKey}
      renderRow={(call) => <ActivityRow call={call} handle={menu.handle} />}
      selectedKey={selectedKey}
      onSelect={onSelect}
      follow={!paused}
      onFollowChange={(follow) => setPaused(!follow)}
      hasMore={feed.hasOlder}
      loadMore={feed.loadOlder}
      scrollToKey={openKey === undefined ? undefined : { key: openKey }}
      empty={
        q === '' ? (
          <EmptyState
            icon={ListMagnifyingGlassIcon}
            title="No calls yet"
            description="Every request your app makes to the Auth emulator appears here with its outcome."
            connect={{ service: 'auth', project: search.project }}
            testId="activity-empty"
          />
        ) : (
          <NoMatch filter={q} noun="calls" onClear={() => setQ('')} />
        )
      }
      testId="activity-feed"
    />
  )

  return (
    <SectionPage section="auth" page="activity" title="Activity" testId="auth-activity">
      <SectionPanel label="Filters">
        <PanelHeader>
          <TenantPicker
            project={project}
            page="activity"
            value={scope}
            onChange={setScope}
            className="flex-1"
          />
        </PanelHeader>
        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-1.5 py-3">
          <FacetList
            groups={activityFacetGroups(feed.facets, q)}
            value={q}
            onChange={setQ}
            testId="activity-facets"
          />
          <div className="grid gap-1 px-2" data-testid="activity-console-toggle">
            <Checkbox
              checked={includeConsole}
              onCheckedChange={(checked) =>
                update(
                  { console: checked === true || undefined, entry: undefined },
                  { replace: true },
                )
              }
              label={<span className="text-[13px]">Include the console’s own edits</span>}
            />
            <span className="pl-6 text-[12px] text-kumo-subtle">
              Try a sign-in and Replay are always shown.
            </span>
          </div>
        </div>
      </SectionPanel>
      <SectionToolbar>
        <ToolbarRow testId="activity-row-one">
          <PanelToggle where="toolbar" />
          {!panelOpen && (
            <TenantPicker
              project={project}
              page="activity"
              value={scope}
              onChange={setScope}
              className="w-56"
              testId="tenant-picker-toolbar"
            />
          )}
          <span className="min-w-0 flex-1" />
          <LiveNotice
            status={feed.status}
            what="the activity"
            onRetry={() => liveChannel.retry()}
          />
          <ToolbarDivider />
          <Button
            variant={search.panel === 'inspect' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={search.panel === 'inspect'}
            onClick={() => (search.panel === 'inspect' ? close() : inspect())}
            data-testid="activity-inspect-token"
          >
            Inspect a token
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setClearing(true)}
            disabled={loaded === 0}
            data-testid="activity-clear"
          >
            Clear history…
          </Button>
        </ToolbarRow>
        <ToolbarRow variant="line" testId="activity-row-two">
          <FilterField
            value={q}
            onChange={onFilter}
            fields={activityFields()}
            placeholder="Filter calls — is:error kind:sign-in ada@"
            ariaLabel="Filter calls"
            testId="activity-filter"
          />
          <MatchCount
            total={feed.page?.total ?? undefined}
            noun={NOUN}
            widest="00,000 calls"
            loading={firstLoad}
            hidden={feed.error !== null}
            tooltip="Every call this filter matches among those the engine keeps, not only the rows loaded."
          />
          <PauseButton paused={paused} pending={pending} onChange={setPaused} />
        </ToolbarRow>
      </SectionToolbar>
      <SectionBody>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {body}
          {feed.ready && feed.error === null && loaded > 0 && (
            <FeedFooter loaded={loaded} capacity={capacity} noun={NOUN} testId="activity-footer" />
          )}
        </div>
        {search.panel === 'inspect' ? (
          <InspectToken project={project} onClose={close} />
        ) : search.entry !== undefined ? (
          <ActivityDetail
            project={project}
            id={search.entry}
            loaded={openCall}
            capacity={capacity}
            bodiesRetained={feed.bodiesRetained}
            replayAsk={replayAsk}
            onClose={close}
            onPrev={newer ? () => open(newer) : undefined}
            onNext={older ? () => open(older) : undefined}
            onOpen={openId}
            onInspect={inspect}
            onLogs={logs}
            onOpenUser={openUser}
          />
        ) : null}
      </SectionBody>
      {menu.popup}
      <DangerConfirm
        open={clearing}
        onOpenChange={setClearing}
        title="Clear the activity history"
        description={`Removes ${loaded === 1 ? 'this call' : `these ${formatNumber(loaded)} calls`} from the console's list.`}
        consequences={[
          'Nothing in the emulator changes: accounts, codes and tokens stay as they are.',
        ]}
        pending={clear.isPending}
        {...(clear.error instanceof Error ? { error: clear.error.message } : {})}
        onConfirm={() => clear.mutate()}
        testId="activity-clear-confirm"
      />
    </SectionPage>
  )
}
