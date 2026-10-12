// One function's page: its toolbar, what is wrong with it or its codebase,
// how it is reached and what it has done, every invocation of it live, and
// beside the list the inspector — Run, Trigger, Environment — or one
// invocation opened from the list.

import { Button, Tooltip } from '@cloudflare/kumo'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { EmptyState } from '@/components/console/empty-state'
import { PauseButton } from '@/components/console/pause-button'
import { RequiresNotice } from '@/components/console/requires-notice'
import type { RowMenuItem } from '@/components/console/row-menu'
import { SectionBanner } from '@/components/console/section-banner'
import { SectionBody } from '@/components/console/section-page'
import { SectionToolbar, ToolbarRow } from '@/components/console/toolbar'
import { Kbd } from '@/components/kit'
import { useFeedPending } from '@/components/console/feed-list'
import { useShortcuts } from '@/lib/shortcuts'
import { hasFailedOnly, toggleFailedOnly, withScopeTerm } from '../filters'
import { functionMenu } from '../function-menu'
import { answersOnUrl, runForm } from '../kinds'
import type { FunctionsSearch, FunctionTab } from '../search'
import { receivesWhat, serviceSection, statusReasonText } from '../trigger-text'
import { copyText, functionUrl, useFunctionsAddress, useLogsLink } from '../use-functions'
import { CodebaseBanners, useReloadCodebase } from './codebase-banners'
import { FunctionToolbar } from './function-toolbar'
import { InvocationList, invocationKey, useInvocationFeed } from './invocation-list'
import { RestartWorkerDialog } from './restart-worker-dialog'
import { RunSidePanel } from './run-side-panel'
import { SummaryStrip } from './summary-strip'

/** What the empty list says, by kind: how this function gets called. */
export function noInvocationsText(summary: FunctionSummary, url: string | undefined): string {
  switch (runForm(summary.kind)) {
    case 'invoke':
      return url
        ? `Use Invoke on the right, or call ${url} from your app.`
        : 'Use Invoke on the right.'
    case 'callable':
      return 'Use Call on the right, or call it from your app with httpsCallable.'
    case 'schedule':
      return 'Use Run now on the right; it also runs on its schedule.'
    case 'task':
      return 'Use Enqueue on the right, or enqueue a task from your app.'
    case 'blocking':
      return 'Use Test on the right, or sign a user up in your app.'
    case 'event':
      if (summary.kind === 'firestore' && summary.trigger.document)
        return `Send a test event on the right, or write a document under ${summary.trigger.document}.`
      if (summary.kind === 'pubsub')
        return 'Send a test event on the right, or publish to its topic.'
      if (summary.kind === 'storage')
        return 'Send a test event on the right, or upload a file to its bucket.'
      return 'Send a test event on the right, or make the change it listens for.'
  }
}

export function FunctionWorkbench({
  project,
  snapshot,
  summary,
  search,
  update,
  run,
  invocationMenu,
  invocationDetail,
}: {
  project: string
  snapshot: FunctionsSnapshot
  summary: FunctionSummary
  search: FunctionsSearch
  update: (patch: Partial<FunctionsSearch>, options?: { replace?: boolean }) => void
  /** The Run tab, given the detail; absent: the inspector opens on Trigger. */
  run?: ((detail: FunctionDetail) => ReactNode) | undefined
  /** The row menu of one invocation. */
  invocationMenu?: ((invocation: InvocationSummary) => readonly RowMenuItem[]) | undefined
  /** The inspector for one invocation (`invocation=`). */
  invocationDetail?: ((id: string) => ReactNode) | undefined
}) {
  const navigate = useNavigate()
  const address = useFunctionsAddress()
  const url = functionUrl(summary, address)
  const logs = useLogsLink({ function: summary.id })
  const codebase = snapshot.codebases.find((entry) => entry.codebase.id === summary.codebase)
  const [restarting, setRestarting] = useState(false)
  const reload = useReloadCodebase(summary.codebase)

  const q = search.q ?? ''
  const feed = useInvocationFeed({
    project,
    q: withScopeTerm(q, { function: summary.id }),
    params: q.trim() === '' ? { function: summary.id } : { function: summary.id, q },
  })
  const paused = search.paused === true
  const pending = useFeedPending(feed.store, paused, invocationKey)

  const tab: FunctionTab | undefined = search.tab
  const inspectorOpen = tab !== undefined || search.invocation !== undefined
  const openTab = (next: FunctionTab) => update({ tab: next, invocation: undefined })
  const primaryTab: FunctionTab = run ? 'run' : 'trigger'

  const menu = functionMenu(summary, codebase?.codebase, {
    run: () => openTab(primaryTab),
    copy: (text, what) => void copyText(text, what),
    url,
    logs: logs
      ? () => void navigate({ to: logs.to as never, search: logs.search as never })
      : undefined,
    invocations: () =>
      void navigate({
        to: '/functions/invocations',
        search: { q: `function:${summary.id}` } as never,
      }),
    openCodebase: () =>
      update({
        function: undefined,
        tab: undefined,
        invocation: undefined,
        q: undefined,
        codebase: summary.codebase,
      }),
    reload: () => reload.mutate(),
    restart: () => setRestarting(true),
  })

  useShortcuts({ id: 'functions.function', label: 'Function' }, [
    {
      key: 'e',
      label: 'Failed invocations only',
      run: () => update({ q: toggleFailedOnly(q) || undefined }, { replace: true }),
    },
    {
      key: 'i',
      label: run ? 'Open the Run tab' : 'Open the Trigger tab',
      run: () => openTab(primaryTab),
    },
    ...(logs
      ? [
          {
            key: 'l',
            label: 'Open in Logs',
            run: () => void navigate({ to: logs.to as never, search: logs.search as never }),
          },
        ]
      : []),
  ])

  const failedOnly = hasFailedOnly(q)
  const missing = summary.secrets.filter((secret) => !secret.provided)
  const needs = summary.status === 'noService' ? serviceSection(summary.service) : undefined

  return (
    <>
      <SectionToolbar>
        <FunctionToolbar
          summary={summary}
          codebase={codebase}
          url={url}
          logs={logs}
          menu={menu}
          runOpen={tab === primaryTab}
          primaryLabel={run ? undefined : 'Details'}
          onRun={() => openTab(primaryTab)}
        />
      </SectionToolbar>
      {codebase && <CodebaseBanners entry={codebase} />}
      {needs && (
        <RequiresNotice
          section={needs}
          for={receivesWhat(summary.kind, summary.name)}
          testId="function-requires"
        />
      )}
      {summary.status === 'ignored' && (
        <SectionBanner tone="warning" testId="function-ignored">
          The emulator ignores {summary.name}.{' '}
          {statusReasonText(summary.statusReason ?? 'It cannot deliver its events.')}
        </SectionBanner>
      )}
      {summary.status === 'removed' && (
        <SectionBanner tone="info" testId="function-removed">
          The last reload removed {summary.name}, so it no longer runs. Its invocations are kept
          below.
        </SectionBanner>
      )}
      {missing.length > 0 && (
        <SectionBanner
          tone="warning"
          testId="function-missing-secrets"
          action={
            <Button variant="secondary" size="xs" onClick={() => openTab('environment')}>
              Add secret
            </Button>
          }
        >
          <span className="font-mono text-[12px]">
            {missing.map((secret) => secret.key).join(', ')}
          </span>{' '}
          {missing.length === 1 ? 'is' : 'are'} declared but not in .secret.local, so{' '}
          <span className="font-mono text-[12px]">process.env.{missing[0]?.key}</span> is undefined
          here.
        </SectionBanner>
      )}
      <SummaryStrip summary={summary} url={url} />
      <ToolbarRow variant="line" testId="function-list-row">
        <Tooltip
          content={
            <span className="flex items-center gap-1.5">
              Show only invocations that failed <Kbd>e</Kbd>
            </span>
          }
          render={
            <Button
              variant={failedOnly ? 'secondary' : 'ghost'}
              size="sm"
              icon={<WarningCircleIcon />}
              aria-pressed={failedOnly}
              onClick={() => update({ q: toggleFailedOnly(q) || undefined }, { replace: true })}
              data-testid="failed-only"
            >
              Failed only
            </Button>
          }
        />
        {q.trim() !== '' && !(failedOnly && q.trim() === 'outcome:failed') && (
          <span
            className="min-w-0 truncate font-mono text-[11px] text-kumo-subtle"
            data-testid="function-list-filter"
          >
            {q}
          </span>
        )}
        <PauseButton
          paused={paused}
          pending={pending}
          onChange={(next) => update({ paused: next }, { replace: true })}
        />
      </ToolbarRow>
      <SectionBody testId="function-body">
        <InvocationList
          feed={feed}
          variant="function"
          follow={!paused}
          onFollowChange={(follow) => update({ paused: !follow }, { replace: true })}
          selected={search.invocation}
          onSelect={
            invocationDetail ? (invocation) => update({ invocation: invocation.id }) : undefined
          }
          menu={invocationMenu ?? (() => [])}
          empty={
            <EmptyState
              icon={WarningCircleIcon}
              title={q.trim() === '' ? 'No invocations yet' : 'No invocations match'}
              description={
                q.trim() === '' ? noInvocationsText(summary, url) : `Nothing kept matches ${q}.`
              }
              commandLine={
                q.trim() === '' && answersOnUrl(summary.kind) && summary.kind === 'http' && url
                  ? `curl ${url}`
                  : undefined
              }
              testId="function-no-invocations"
            />
          }
          testId="function-invocations"
        />
        {inspectorOpen &&
          (search.invocation && invocationDetail ? (
            invocationDetail(search.invocation)
          ) : (
            <RunSidePanel
              project={project}
              summary={summary}
              tab={tab ?? primaryTab}
              onTab={openTab}
              onClose={() => update({ tab: undefined, invocation: undefined })}
              run={run}
            />
          ))}
      </SectionBody>
      <RestartWorkerDialog
        open={restarting}
        onOpenChange={setRestarting}
        codebase={summary.codebase}
        inFlight={codebase?.codebase.worker.inFlight ?? 0}
      />
    </>
  )
}

/** The page of a function the snapshot no longer has: gone, or moved to another region. */
export function MissingFunction({
  id,
  snapshot,
  onOpen,
  onBack,
}: {
  id: string
  snapshot: FunctionsSnapshot
  onOpen: (id: string) => void
  onBack: () => void
}) {
  const name = id.replace(/^[a-z]+-[a-z]+\d+-/, '')
  const moved = snapshot.functions.find((summary) => summary.name === name && summary.id !== id)
  return (
    <EmptyState
      icon={WarningCircleIcon}
      title={moved ? `This function moved to ${moved.region}` : `No function ${id} is loaded`}
      description={
        moved
          ? `${name} now runs as ${moved.id}; ${id} is gone since the last reload.`
          : 'It may have been removed by a reload, or the link is from another project.'
      }
      actions={
        moved ? (
          <Button
            variant="primary"
            onClick={() => onOpen(moved.id)}
            data-testid="function-moved-open"
          >
            Open
          </Button>
        ) : (
          <Button variant="secondary" onClick={onBack}>
            All functions
          </Button>
        )
      }
      testId="function-missing"
    />
  )
}
