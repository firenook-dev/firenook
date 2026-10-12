// The Functions section's first page (`/functions`): the panel of codebases
// and functions beside one of three views — every function (the overview),
// one codebase (`codebase=`), or one function (`function=`). The snapshot
// comes from `GET /functions` and is kept current by one `functions.events`
// subscription, opened after the cursor the snapshot carries: stats replace,
// codebases replace, a completed load refreshes what it changed and raises
// its toast. Nothing polls.

import { Loader } from '@cloudflare/kumo'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { FunctionCodebaseEntry } from '@/api/generated/compute/FunctionCodebaseEntry'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import {
  EmptyState,
  QueryError,
  TableSkeleton,
  useDelayedFlag,
} from '@/components/console/empty-state'
import { FilterField, type FilterFieldSpec } from '@/components/console/filter-field'
import { LiveNotice } from '@/components/console/live-notice'
import { MatchCount } from '@/components/console/match-count'
import type { RowMenuItem } from '@/components/console/row-menu'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import { SectionToolbar, ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { PanelToggle } from '@/components/shell/section-panel'
import { useNow } from '@/lib/clock'
import { formatCount } from '@/lib/format'
import { liveChannel } from '@/lib/live/channel'
import { parseSort, printSort, useRouteSearch } from '@/lib/search-params'
import { FolderSimpleIcon } from '@phosphor-icons/react'
import { functionsSnapshotQuery, reloadCodebase } from '../api'
import { OVERVIEW_FIELDS, type OverviewRow } from '../filters'
import { functionMenu } from '../function-menu'
import {
  ALL_NODE,
  type TreeTarget,
  codebaseNode,
  discoveringText,
  functionNode,
} from '../functions-tree'
import { useFunctionsEvents } from '../live'
import { useFunctionsPalette } from '../palette'
import type { FunctionsSearch } from '../search'
import { copyText, functionUrl, useFunctionsAddress, useFunctionsProject } from '../use-functions'
import { CodebaseView } from './codebase-view'
import { FunctionWorkbench, MissingFunction } from './function-workbench'
import { FunctionsPanel } from './functions-panel'
import { FunctionsOverview, overviewCount } from './overview'
import { RestartWorkerDialog } from './restart-worker-dialog'

/** What the pages built on top of this one add: the Run tab, invocation rows' menus and detail. */
export interface FunctionsPageParts {
  run?: ((detail: FunctionDetail) => ReactNode) | undefined
  invocationMenu?: ((invocation: InvocationSummary) => readonly RowMenuItem[]) | undefined
  invocationDetail?: ((id: string) => ReactNode) | undefined
}

/** The overview's fields, with the codebases of this engine offered after `codebase:`. */
function overviewFields(snapshot: FunctionsSnapshot): FilterFieldSpec[] {
  const ids = snapshot.codebases.map((entry) => entry.codebase.id)
  return OVERVIEW_FIELDS.map((field) =>
    field.key === 'codebase'
      ? Object.assign({}, field, {
          suggest: (prefix: string) => ids.filter((id) => id.startsWith(prefix)),
        })
      : field,
  )
}

/** The first toolbar row of a view that has nothing else to say yet (loading, failed). */
function PlainToolbar({ title }: { title: string }) {
  return (
    <SectionToolbar>
      <ToolbarRow>
        <PanelToggle where="toolbar" />
        <span className="truncate px-1 text-[13px] text-kumo-default">{title}</span>
      </ToolbarRow>
    </SectionToolbar>
  )
}

const NO_PARTS: FunctionsPageParts = {}

export function FunctionsPage({ parts = NO_PARTS }: { parts?: FunctionsPageParts }) {
  const { search, update } = useRouteSearch<FunctionsSearch>('/functions', '/functions')
  const navigate = useNavigate()
  const project = useFunctionsProject()
  const address = useFunctionsAddress()
  const snapshot = useQuery({ ...functionsSnapshotQuery(project), enabled: project !== '' })
  const live = useFunctionsEvents(snapshot.data ? {} : null, { after: snapshot.data?.liveCursor })
  const slow = useDelayedFlag(snapshot.isPending)
  const [restarting, setRestarting] = useState<string | null>(null)

  const openFunction = (id: string) =>
    update({
      function: id,
      codebase: undefined,
      tab: undefined,
      invocation: undefined,
      prefill: undefined,
      q: undefined,
      sort: undefined,
      paused: undefined,
      source: undefined,
    })
  const openCodebase = (codebase: string) =>
    update({
      codebase,
      function: undefined,
      tab: undefined,
      invocation: undefined,
      prefill: undefined,
      q: undefined,
      sort: undefined,
      paused: undefined,
      source: undefined,
    })
  const openAll = () =>
    update({
      codebase: undefined,
      function: undefined,
      tab: undefined,
      invocation: undefined,
      prefill: undefined,
      q: undefined,
      paused: undefined,
      source: undefined,
    })
  const showInvocations = (q?: string) =>
    void navigate({ to: '/functions/invocations', search: (q ? { q } : {}) as never })

  const onTree = (target: TreeTarget) => {
    if (target.kind === 'all') openAll()
    else if (target.kind === 'function') openFunction(target.id)
    else openCodebase(target.codebase)
  }

  useFunctionsPalette(snapshot.data, {
    openFunction,
    openCodebase,
    reload: (codebase) => void reloadCodebase(codebase),
    restart: (codebase) => setRestarting(codebase),
    showInvocations,
    current: search.function
      ? {
          id: search.function,
          run: () => update({ tab: parts.run ? 'run' : 'trigger', invocation: undefined }),
          copyUrl: (() => {
            const summary = snapshot.data?.functions.find((entry) => entry.id === search.function)
            const url = summary ? functionUrl(summary, address) : undefined
            return url ? () => void copyText(url, 'the URL') : undefined
          })(),
        }
      : undefined,
  })

  const current = search.function
    ? functionNode(search.function)
    : search.codebase
      ? codebaseNode(search.codebase)
      : ALL_NODE

  let body: ReactNode
  if (snapshot.error) {
    body = (
      <>
        <PlainToolbar title="Functions" />
        <QueryError
          error={snapshot.error}
          onRetry={() => void snapshot.refetch()}
          section="functions"
        />
      </>
    )
  } else if (!snapshot.data) {
    body = (
      <>
        <PlainToolbar title="All functions" />
        {slow && (
          <TableSkeleton
            columns={[
              { width: 230 },
              { width: 100 },
              { width: 340 },
              { width: 130 },
              { width: 110 },
            ]}
          />
        )}
      </>
    )
  } else if (search.function) {
    const summary = snapshot.data.functions.find((entry) => entry.id === search.function)
    body = summary ? (
      <FunctionWorkbench
        key={summary.id}
        project={project}
        snapshot={snapshot.data}
        summary={summary}
        search={search}
        update={update}
        run={parts.run}
        invocationMenu={parts.invocationMenu}
        invocationDetail={parts.invocationDetail}
      />
    ) : (
      <>
        <PlainToolbar title={search.function} />
        <MissingFunction
          id={search.function}
          snapshot={snapshot.data}
          onOpen={openFunction}
          onBack={openAll}
        />
      </>
    )
  } else if (search.codebase) {
    const entry = snapshot.data.codebases.find(
      (candidate) => candidate.codebase.id === search.codebase,
    )
    const first = snapshot.data.functions.find((summary) => summary.codebase === search.codebase)
    body = entry ? (
      <CodebaseView
        key={entry.codebase.id}
        project={project}
        snapshot={snapshot.data}
        entry={entry}
        onOpenEnvironment={
          first
            ? () => update({ function: first.id, codebase: undefined, tab: 'environment' })
            : undefined
        }
      />
    ) : (
      <>
        <PlainToolbar title={search.codebase} />
        <EmptyState
          icon={FolderSimpleIcon}
          title={`No codebase ${search.codebase}`}
          description="firebase.json names no codebase or extension instance by that id in this engine."
          testId="codebase-missing"
        />
      </>
    )
  } else {
    const data = snapshot.data
    const q = search.q ?? ''
    const sort = parseSort(search.sort)
    const menuFor = (row: OverviewRow): RowMenuItem[] => {
      if (row.kind === 'notLoaded')
        return [
          { id: 'copy-id', label: 'Copy id', run: () => void copyText(row.entry.id, 'the id') },
          { id: 'codebase', label: 'Open codebase', run: () => openCodebase(row.codebase) },
        ]
      const summary = row.summary
      const codebase = data.codebases.find((entry) => entry.codebase.id === summary.codebase)
      return functionMenu(summary, codebase?.codebase, {
        open: () => openFunction(summary.id),
        run: () =>
          update({
            function: summary.id,
            codebase: undefined,
            tab: parts.run ? 'run' : 'trigger',
            q: undefined,
            sort: undefined,
          }),
        copy: (text, what) => void copyText(text, what),
        url: functionUrl(summary, address),
        invocations: () => showInvocations(`function:${summary.id}`),
        openCodebase: () => openCodebase(summary.codebase),
        reload: () => void reloadCodebase(summary.codebase),
        restart: () => setRestarting(summary.codebase),
      })
    }
    body = (
      <>
        <SectionToolbar>
          <ToolbarRow testId="functions-toolbar">
            <PanelToggle where="toolbar" />
            <span
              className="truncate px-1 text-[13px] text-kumo-default"
              data-testid="functions-scope"
            >
              All functions
            </span>
            <ToolbarDivider />
            <LiveNotice status={live} what="the functions" onRetry={() => liveChannel.retry()} />
          </ToolbarRow>
          <ToolbarRow variant="line">
            <FilterField
              value={q}
              onChange={(text) => update({ q: text }, { replace: true })}
              fields={overviewFields(data)}
              placeholder="Filter functions — kind:firestore status:ignored codebase:app name"
              ariaLabel="Filter functions"
              testId="functions-filter-field"
            />
            <MatchCount
              total={{ count: overviewCount(data, q), exact: true }}
              noun={{ one: 'function', other: 'functions' }}
              widest="0,000"
              tooltip="Every function the filter keeps, of every codebase."
            />
          </ToolbarRow>
        </SectionToolbar>
        <SectionBody>
          <FunctionsOverview
            snapshot={data}
            q={q}
            sort={sort}
            onSortChange={(next) =>
              update(
                {
                  sort:
                    next && !(next.column === 'name' && next.direction === 'asc')
                      ? printSort(next)
                      : undefined,
                },
                { replace: true },
              )
            }
            onClearFilter={() => update({ q: undefined })}
            onOpen={(row) =>
              row.kind === 'notLoaded' ? openCodebase(row.codebase) : openFunction(row.summary.id)
            }
            rowMenu={menuFor}
          />
        </SectionBody>
      </>
    )
  }

  const restartEntry = restarting
    ? snapshot.data?.codebases.find((entry) => entry.codebase.id === restarting)
    : undefined
  return (
    <SectionPage section="functions" page="functions" title="Functions" testId="functions-page">
      <FunctionsPanel snapshot={snapshot.data} current={current} onOpen={onTree} />
      {body}
      <RestartWorkerDialog
        open={restarting !== null}
        onOpenChange={(open) => {
          if (!open) setRestarting(null)
        }}
        codebase={restarting ?? ''}
        inFlight={restartEntry?.codebase.worker.inFlight ?? 0}
      />
    </SectionPage>
  )
}

/** The section's starting view: each codebase discovering, from the Monitor, filling in live. */
export function FunctionsStarting() {
  const project = useFunctionsProject()
  const snapshot = useQuery({ ...functionsSnapshotQuery(project), enabled: project !== '' })
  useFunctionsEvents(snapshot.data ? { changesOnly: true } : null, {
    after: snapshot.data?.liveCursor,
    toasts: false,
  })
  const codebases = snapshot.data?.codebases ?? []
  if (codebases.length === 0) return null
  return (
    <ul className="m-0 grid gap-1.5 p-0" data-testid="functions-starting">
      {codebases.map((entry) => (
        <li key={entry.codebase.id} className="flex list-none items-center gap-2">
          <span className="font-mono text-[12px] text-kumo-default">{entry.codebase.id}</span>
          <StartingState entry={entry} />
        </li>
      ))}
    </ul>
  )
}

function StartingState({ entry }: { entry: FunctionCodebaseEntry }) {
  const now = useNow('second')
  const codebase = entry.codebase
  if (codebase.state === 'loading')
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-kumo-subtle">
        <Loader size="sm" />
        {discoveringText(codebase.loadingSince, now)}
      </span>
    )
  if (codebase.state === 'failed')
    return <span className="text-[12px] text-kumo-danger">Failed</span>
  return (
    <span className="text-[12px] text-kumo-subtle">
      Ready · {formatCount(codebase.functionCount, { one: 'function', other: 'functions' })}
    </span>
  )
}
