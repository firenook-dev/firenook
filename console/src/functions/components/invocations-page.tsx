// Every invocation of every function, live (`/functions/invocations`): the
// panel's tree picks a function or a codebase (a `function:` or
// `codebase:` term in the filter), the filter is the engine's — the same
// text filters the newest page and the live tail — and the inspector holds
// the one opened. Pause holds the list still; Clear history empties the
// engine's record.

import { Button } from '@cloudflare/kumo'
import { ListIcon, TrashIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/api/client'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { EmptyState, NoMatch } from '@/components/console/empty-state'
import { FilterField } from '@/components/console/filter-field'
import { LiveNotice } from '@/components/console/live-notice'
import { MatchCount } from '@/components/console/match-count'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import { PauseButton } from '@/components/console/pause-button'
import { useSeededPending } from '@/compute/seeded-pending'
import { SectionToolbar, ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { PanelToggle } from '@/components/shell/section-panel'
import { checkFilter } from '@/lib/filter'
import { formatNumber } from '@/lib/format'
import { liveChannel } from '@/lib/live/channel'
import { useRouteSearch } from '@/lib/search-params'
import { useShortcuts } from '@/lib/shortcuts'
import { clearInvocations, functionKeys, functionsSnapshotQuery } from '../api'
import { invocationFields, scopeOf, toggleFailedOnly, withScopeTerm } from '../filters'
import { ALL_NODE, codebaseNode, functionNode } from '../functions-tree'
import { useFunctionsPalette } from '../palette'
import type { InvocationsSearch } from '../search'
import { useFunctionsProject } from '../use-functions'
import { CodebaseBanners } from './codebase-banners'
import { FunctionsPanel } from './functions-panel'
import { useInvocationActions } from './invocation-actions'
import { InvocationDetail } from './invocation-detail'
import {
  InvocationList,
  invocationKey,
  kept,
  neighbour,
  useInvocationFeed,
} from './invocation-list'
import { InvocationsHeader, shortFunction } from './invocation-row'

export function InvocationsPage() {
  const { search, update } = useRouteSearch<InvocationsSearch>(
    '/functions_/invocations',
    '/functions/invocations',
  )
  const project = useFunctionsProject()
  const client = useQueryClient()
  const snapshot = useQuery({ ...functionsSnapshotQuery(project), enabled: project !== '' })
  const q = search.q ?? ''
  const fields = invocationFields({
    functionIds: snapshot.data?.functions.map((summary) => summary.id),
    codebases: snapshot.data?.codebases.map((entry) => entry.codebase.id),
  })
  // The list follows the last filter that reads; one being typed waits.
  const valid = checkFilter(q, { fields }).ok
  const [applied, setApplied] = useState(q)
  if (valid && applied !== q) setApplied(q)
  const feed = useInvocationFeed({
    project,
    q: applied,
    params: applied.trim() === '' ? {} : { q: applied },
    toasts: true,
  })
  const paused = search.paused === true
  const pending = useSeededPending(feed.store, paused, invocationKey, feed.total)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | undefined>()
  const [clearPending, setClearPending] = useState(false)

  const open = (id: string) => update({ invocation: id })
  const actions = useInvocationActions({ onOpen: open })
  const selected = () => kept(feed.store, search.invocation)

  const scope = scopeOf(q)
  const current =
    scope && 'function' in scope
      ? functionNode(scope.function)
      : scope && 'codebase' in scope
        ? codebaseNode(scope.codebase)
        : ALL_NODE
  const scopeCodebase =
    scope && 'codebase' in scope
      ? scope.codebase
      : scope && 'function' in scope
        ? snapshot.data?.functions.find((summary) => summary.id === scope.function)?.codebase
        : undefined
  const codebaseEntry = scopeCodebase
    ? snapshot.data?.codebases.find((entry) => entry.codebase.id === scopeCodebase)
    : undefined
  const label =
    scope && 'function' in scope
      ? shortFunction(scope.function)
      : scope && 'codebase' in scope
        ? scope.codebase
        : 'All functions'

  useFunctionsPalette(snapshot.data, {
    openFunction: (id) => update({ q: withScopeTerm(q, { function: id }), invocation: undefined }),
    openCodebase: (codebase) =>
      update({ q: withScopeTerm(q, { codebase }), invocation: undefined }),
    reload: () => undefined,
    restart: () => undefined,
    showInvocations: (next) => update({ q: next ?? undefined, invocation: undefined }),
    clearHistory: () => setClearing(true),
  })

  const onSelected =
    (run: (invocation: NonNullable<ReturnType<typeof selected>>) => void) => () => {
      const invocation = selected()
      if (invocation) run(invocation)
    }
  const has = () => selected() !== undefined
  useShortcuts({ id: 'functions.invocations', label: 'Invocations' }, [
    {
      key: 'e',
      label: 'Failed invocations only',
      run: () => update({ q: toggleFailedOnly(q) || undefined }, { replace: true }),
    },
    { key: 'r', label: 'Replay the invocation', when: has, run: onSelected(actions.askReplay) },
    { key: 'Shift+R', label: 'Edit and replay', when: has, run: onSelected(actions.editAndReplay) },
    ...(actions.openLogs
      ? [{ key: 'l', label: 'Open in Logs', when: has, run: onSelected(actions.openLogs) }]
      : []),
    { key: 'c', label: 'Copy the invocation id', when: has, run: onSelected(actions.copyId) },
    {
      key: 'Shift+C',
      label: 'Copy the invocation as JSON',
      when: has,
      run: onSelected(actions.copyJson),
    },
  ])

  const clear = () => {
    setClearPending(true)
    setClearError(undefined)
    clearInvocations()
      .then(() => {
        setClearing(false)
        update({ invocation: undefined })
        void client.invalidateQueries({ queryKey: functionKeys.all(project) })
      })
      .catch((error: unknown) =>
        setClearError(error instanceof ApiError ? error.message : String(error)),
      )
      .finally(() => setClearPending(false))
  }

  const newer = search.invocation ? neighbour(feed.store, search.invocation, 1) : undefined
  const older = search.invocation ? neighbour(feed.store, search.invocation, -1) : undefined
  const total = feed.total ?? 0

  return (
    <SectionPage
      section="functions"
      page="invocations"
      title="Invocations"
      testId="invocations-page"
    >
      <FunctionsPanel
        snapshot={snapshot.data}
        current={current}
        onOpen={(target) =>
          update({
            q:
              withScopeTerm(
                q,
                target.kind === 'function'
                  ? { function: target.id }
                  : target.kind === 'codebase' || target.kind === 'notLoaded'
                    ? { codebase: target.codebase }
                    : undefined,
              ) || undefined,
            invocation: undefined,
          })
        }
      />
      <SectionToolbar>
        <ToolbarRow testId="invocations-toolbar">
          <PanelToggle where="toolbar" />
          <span
            className="min-w-0 truncate px-1 font-mono text-[13px] text-kumo-default"
            data-testid="invocations-scope"
          >
            {label === 'All functions' ? <span className="font-sans">{label}</span> : label}
          </span>
          <ToolbarDivider />
          <LiveNotice
            status={feed.live}
            what="the invocations"
            onRetry={() => liveChannel.retry()}
          />
          <span className="ml-auto flex items-center">
            <ToolbarDivider />
            <Button
              variant="ghost"
              size="sm"
              icon={<TrashIcon className="text-kumo-danger" />}
              onClick={() => setClearing(true)}
              data-testid="invocations-clear"
            >
              <span className="text-kumo-danger">Clear history…</span>
            </Button>
          </span>
        </ToolbarRow>
        <ToolbarRow variant="line">
          <FilterField
            value={q}
            onChange={(text) => update({ q: text }, { replace: true })}
            fields={fields}
            placeholder="Filter invocations — function:us-central1-api outcome:failed took:>200ms is:cold"
            ariaLabel="Filter invocations"
            testId="invocations-filter"
          />
          <MatchCount
            total={feed.total === undefined ? undefined : { count: total, exact: true }}
            loading={feed.loading}
            noun={{ one: 'invocation', other: 'invocations' }}
            widest="0,000"
            tooltip="Every kept invocation the filter matches; the engine keeps the newest 2,000."
          />
          <PauseButton
            paused={paused}
            pending={pending}
            onChange={(next) => update({ paused: next }, { replace: true })}
          />
        </ToolbarRow>
      </SectionToolbar>
      {codebaseEntry && <CodebaseBanners entry={codebaseEntry} />}
      <SectionBody testId="invocations-body">
        <InvocationList
          feed={feed}
          variant="all"
          follow={!paused}
          onFollowChange={(follow) => update({ paused: !follow }, { replace: true })}
          selected={search.invocation}
          onSelect={(invocation) => open(invocation.id)}
          onOpenTarget={actions.openCause}
          menu={actions.menu}
          header={<InvocationsHeader />}
          empty={
            applied.trim() === '' ? (
              <EmptyState
                icon={ListIcon}
                title="No invocations yet"
                description="Call a function from your app, write what a trigger listens for, or use a function's Run tab; every invocation appears here as it happens."
                testId="invocations-empty"
              />
            ) : (
              <NoMatch
                filter={applied}
                onClear={() => update({ q: undefined })}
                noun="invocations"
              />
            )
          }
          testId="invocations-list"
        />
        {search.invocation && (
          <InvocationDetail
            key={search.invocation}
            project={project}
            id={search.invocation}
            widthKey="functions.invocation"
            actions={actions}
            onClose={() => update({ invocation: undefined })}
            onPrev={newer ? () => update({ invocation: newer.id }, { replace: true }) : undefined}
            onNext={older ? () => update({ invocation: older.id }, { replace: true }) : undefined}
          />
        )}
      </SectionBody>
      {actions.dialog}
      <DangerConfirm
        open={clearing}
        onOpenChange={(next) => {
          setClearing(next)
          if (!next) setClearError(undefined)
        }}
        title={`Clear the history of ${formatNumber(total)} ${total === 1 ? 'invocation' : 'invocations'}`}
        description="The console's record of every invocation goes: their requests, answers, timings and log lines."
        consequences={[
          'Function stats reset too.',
          "Nothing in your project changes; only the console's record goes.",
        ]}
        {...(clearError === undefined ? {} : { error: clearError })}
        pending={clearPending}
        onConfirm={clear}
        testId="invocations-clear-confirm"
      />
    </SectionPage>
  )
}
