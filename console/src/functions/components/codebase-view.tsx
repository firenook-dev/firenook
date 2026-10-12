// A codebase itself (`/functions?codebase=app`): what it loaded, the worker
// behind it, and what it printed outside any invocation — the home for
// "why did my code fail to load?" and "restart a wedged worker". Three
// cards (the worker, the last load, the env files) over the load log, which
// is the Monitor's last 200 lines for the codebase and then every new one
// as it is printed, followed after the cursor its `GET` returned.

import { Button, DropdownMenu, Loader, Text, Tooltip } from '@cloudflare/kumo'
import { ArrowClockwiseIcon, BugIcon, CaretDownIcon, PowerIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import type { FunctionCodebaseEntry } from '@/api/generated/compute/FunctionCodebaseEntry'
import type { FunctionLogLine } from '@/api/generated/compute/FunctionLogLine'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import { CopyButton } from '@/components/console/copy-button'
import { EntityLink } from '@/components/console/entity-link'
import { QueryError } from '@/components/console/empty-state'
import { useFeedPending } from '@/components/console/feed-list'
import { PauseButton } from '@/components/console/pause-button'
import { RelativeTime } from '@/components/console/relative-time'
import { serviceAddress } from '@/components/console/request/address'
import {
  SectionToolbar,
  ToolbarDivider,
  ToolbarField,
  ToolbarRow,
} from '@/components/console/toolbar'
import { StatusDot, type StatusTone } from '@/components/kit'
import { PanelToggle } from '@/components/shell/section-panel'
import { useNow } from '@/lib/clock'
import { formatCount, formatDuration } from '@/lib/format'
import { createFeedStore } from '@/lib/live/feed-store'
import { statusQuery } from '@/api/queries'
import { codebaseLogQuery } from '../api'
import { useCodebaseLog } from '../live'
import { copyText } from '../use-functions'
import { CodebaseBanners, exitWords, useReloadCodebase } from './codebase-banners'
import { LogLines, lineKey } from './log-lines'
import { RestartWorkerDialog } from './restart-worker-dialog'

/** The worker card's state word and tone. */
export function workerWord(entry: FunctionCodebaseEntry): {
  word: string
  tone: StatusTone
  pulse: boolean
} {
  const worker = entry.codebase.worker
  switch (worker.state) {
    case 'running':
      return { word: 'Running', tone: 'success', pulse: false }
    case 'starting':
      return { word: 'Starting', tone: 'neutral', pulse: true }
    case 'exited':
      return {
        word: `Exited (${exitWords(worker.lastExit).replace(/^exited \(?|\)$/g, '') || 'stopped'})`,
        tone: 'warning',
        pulse: false,
      }
    case 'failed':
      return { word: 'Failed to start', tone: 'danger', pulse: false }
    case 'stopped':
      return { word: 'Starts on the next call', tone: 'neutral', pulse: false }
  }
}

/** "1 added, 1 changed" for a load's diff; "no function changes" when it changed nothing. */
export function diffText(
  diff: { added: readonly string[]; removed: readonly string[]; changed: readonly string[] } | null,
): string {
  if (!diff) return 'no load yet'
  const parts = [
    diff.added.length > 0 ? `${diff.added.length} added` : '',
    diff.changed.length > 0 ? `${diff.changed.length} changed` : '',
    diff.removed.length > 0 ? `${diff.removed.length} removed` : '',
  ].filter(Boolean)
  return parts.length === 0 ? 'no function changes' : parts.join(', ')
}

function Card({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return (
    <section
      className="grid min-w-0 content-start gap-1.5 rounded-lg px-4 py-3 ring ring-kumo-line"
      aria-label={title}
      data-testid={testId}
    >
      <h3 className="m-0 text-[12px] font-normal text-kumo-subtle">{title}</h3>
      {children}
    </section>
  )
}

function Fact({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] [overflow-wrap:anywhere] text-kumo-default">
      {children}
    </p>
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12px] tabular-nums">{children}</span>
}

function Uptime({ since }: { since: string }) {
  const now = useNow('minute')
  const started = Date.parse(since)
  if (Number.isNaN(started)) return null
  return <span>up {formatDuration(Math.max(0, now - started)).replace(/\.\d+ s$/, ' s')}</span>
}

function WorkerCard({ entry }: { entry: FunctionCodebaseEntry }) {
  const worker = entry.codebase.worker
  const state = workerWord(entry)
  return (
    <Card title="Worker" testId="codebase-worker">
      <Fact>
        <StatusDot
          tone={state.tone}
          label={state.word}
          pulse={state.pulse}
          testId="codebase-worker-state"
        />
        {worker.pid !== null && (
          <>
            <span className="text-kumo-subtle">· pid</span>
            <Mono>{worker.pid}</Mono>
          </>
        )}
        {worker.node && (
          <>
            <span className="text-kumo-subtle">· Node</span>
            <Mono>{worker.node}</Mono>
          </>
        )}
      </Fact>
      <Fact>
        <span className="text-kumo-subtle">
          {worker.state === 'running' && worker.startedAt ? (
            <Uptime since={worker.startedAt} />
          ) : (
            'not running'
          )}
          {' · '}
          {formatCount(worker.restarts, { one: 'restart', other: 'restarts' })}
          {' · '}
          {worker.inFlight} in flight
        </span>
      </Fact>
      {worker.startMs !== null && (
        <Fact>
          <span className="text-kumo-subtle">started in</span>
          <Mono>{formatDuration(worker.startMs)}</Mono>
        </Fact>
      )}
      {worker.lastExit && (
        <Fact>
          <span className="text-kumo-subtle">last exit:</span>
          <span>{worker.lastExit}</span>
          {worker.exitedAt && <RelativeTime iso={worker.exitedAt} className="text-kumo-subtle" />}
        </Fact>
      )}
    </Card>
  )
}

function LoadedCard({ entry }: { entry: FunctionCodebaseEntry }) {
  const codebase = entry.codebase
  const change = codebase.lastChange
  const names = change
    ? [...change.added, ...change.changed, ...change.removed].map((id) =>
        id.replace(/^[a-z]+-[a-z]+\d+-/, ''),
      )
    : []
  return (
    <Card title="Loaded" testId="codebase-loaded">
      {codebase.state === 'loading' ? (
        <Fact>
          <Loader size="sm" />
          <span>Discovering functions…</span>
        </Fact>
      ) : codebase.loadedAt ? (
        <Fact>
          <RelativeTime iso={codebase.loadedAt} className="text-[13px] text-kumo-default" />
          {codebase.loadMs !== null && (
            <>
              <span className="text-kumo-subtle">· took</span>
              <Mono>{formatDuration(codebase.loadMs)}</Mono>
            </>
          )}
        </Fact>
      ) : (
        <Fact>
          <span className="text-kumo-danger">Never loaded</span>
        </Fact>
      )}
      <Fact>
        <span className="text-kumo-subtle" data-testid="codebase-loads">
          {formatCount(codebase.loads, { one: 'load', other: 'loads' })}
          {codebase.state === 'failed' ? '' : ' ·'}
        </span>
        {codebase.state !== 'failed' && (
          <Tooltip
            content={names.length > 0 ? names.join(', ') : 'The last load changed no function.'}
            render={<span className="cursor-default text-kumo-subtle">{diffText(change)}</span>}
          />
        )}
      </Fact>
      {codebase.state === 'failed' && (
        <Fact>
          <span className="text-kumo-danger">
            The last load failed; its error is in the strip above.
          </span>
        </Fact>
      )}
      {codebase.notLoaded.length > 0 && (
        <ul className="m-0 grid gap-0.5 p-0" data-testid="codebase-not-loaded">
          {codebase.notLoaded.map((dropped) => (
            <li
              key={dropped.id}
              className="list-none text-[12px] [overflow-wrap:anywhere] text-kumo-subtle"
            >
              Not loaded:{' '}
              <span className="font-mono text-kumo-default">
                {dropped.id.replace(/^[a-z]+-[a-z]+\d+-/, '')}
              </span>{' '}
              — {dropped.reason}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function EnvFilesCard({
  entry,
  onOpenFile,
}: {
  entry: FunctionCodebaseEntry
  onOpenFile?: (() => void) | undefined
}) {
  const codebase = entry.codebase
  const changed = codebase.stale?.reason === 'envChanged' ? codebase.stale.file : undefined
  return (
    <Card title="Environment files" testId="codebase-env-files">
      {codebase.envFiles.length === 0 ? (
        <Fact>
          <span className="text-kumo-subtle">No env file was loaded.</span>
        </Fact>
      ) : (
        <ul className="m-0 grid gap-0.5 p-0">
          {codebase.envFiles.map((file) => (
            <li key={file} className="flex list-none items-baseline gap-2">
              {onOpenFile ? (
                <Tooltip
                  content="Open the Environment tab"
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={onOpenFile}
                      className="-ml-1.5 font-mono text-[12px]"
                    >
                      {file}
                    </Button>
                  }
                />
              ) : (
                <span className="font-mono text-[12px] text-kumo-default">{file}</span>
              )}
              {changed === file && (
                <span className="text-[11px] text-kumo-warning">changed after the last load</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Fact>
        <span className="text-[11px] text-kumo-subtle">In precedence order: later files win.</span>
      </Fact>
    </Card>
  )
}

/** The load log, seeded from the Monitor and followed live. */
function LoadLog({ project, codebase }: { project: string; codebase: string }) {
  // The view is keyed by codebase, so one store serves its life.
  const [store] = useState(() => createFeedStore<FunctionLogLine>({ max: 2_000, key: lineKey }))
  const log = useQuery({ ...codebaseLogQuery(project, codebase), enabled: project !== '' })
  const [paused, setPaused] = useState(false)
  const pending = useFeedPending(store, paused, lineKey)
  const seeded = log.data
  useEffect(() => {
    if (!seeded) return
    store.clear()
    store.push(seeded.lines)
  }, [seeded, store])
  useCodebaseLog(seeded ? codebase : null, {
    after: seeded?.liveCursor,
    onLines: (lines) => store.upsert(lines),
  })
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Load log"
      data-testid="codebase-log"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-y border-kumo-line px-3">
        <h3 className="m-0 text-[12px] font-normal text-kumo-subtle">Load log</h3>
        <span className="text-[11px] text-kumo-subtle">
          What the worker printed outside any invocation, and the runtime's lines about it
        </span>
        <PauseButton
          paused={paused}
          pending={pending}
          onChange={setPaused}
          testId="codebase-log-pause"
        />
      </div>
      {log.error ? (
        <QueryError error={log.error} onRetry={() => void log.refetch()} section="functions" />
      ) : (
        <LogLines
          ariaLabel={`${codebase} load log`}
          store={store}
          mode="codebase"
          follow={!paused}
          onFollowChange={(follow) => setPaused(!follow)}
          empty={<p className="px-3 py-2 text-[13px] text-kumo-subtle">Nothing printed yet.</p>}
          className="min-h-0 flex-1"
          testId="codebase-log-lines"
        />
      )}
    </section>
  )
}

function DebugChip({ port }: { port: number }) {
  const status = useQuery(statusQuery)
  const host = serviceAddress('functions', status.data)?.host ?? '127.0.0.1'
  const address = `${host.includes(':') ? `[${host}]` : host}:${port}`
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="secondary" size="sm" icon={<BugIcon />} data-testid="codebase-debug">
            <span className="flex items-center gap-1.5">
              Debug <span className="font-mono text-[12px]">{port}</span>
              <CaretDownIcon size={12} className="text-kumo-subtle" />
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content className="w-72">
        <DropdownMenu.Item
          onClick={() => void copyText(address, `${address}`)}
          data-testid="codebase-debug-copy"
        >
          Copy <span className="font-mono text-[12px]">chrome://inspect</span> address
        </DropdownMenu.Item>
        <div className="px-2 py-1.5 text-[12px] text-kumo-subtle">
          Add <span className="font-mono">{address}</span> under Discover network targets. Timeouts
          are off while debugging.
        </div>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

export function CodebaseView({
  project,
  snapshot,
  entry,
  onOpenEnvironment,
}: {
  project: string
  snapshot: FunctionsSnapshot
  entry: FunctionCodebaseEntry
  /** Opens the Environment tab of the codebase's first function. */
  onOpenEnvironment?: (() => void) | undefined
}) {
  const codebase = entry.codebase
  const [restarting, setRestarting] = useState(false)
  const reload = useReloadCodebase(codebase.id)
  const extension = codebase.kind === 'extension'
  const count = snapshot.functions.filter((summary) => summary.codebase === codebase.id).length
  return (
    <>
      <SectionToolbar>
        <ToolbarRow testId="codebase-toolbar">
          <PanelToggle where="toolbar" />
          <ToolbarField
            testId="codebase-identity"
            trailing={<CopyButton value={codebase.directory} label="Copy the directory" />}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-[13px] text-kumo-default">
                {codebase.id}
              </span>
              <span className="shrink-0 truncate font-mono text-[12px] text-kumo-subtle">
                {codebase.directory}
              </span>
              <span className="hidden shrink-0 text-[12px] text-kumo-subtle lg:inline">
                {[
                  codebase.runtime,
                  formatCount(count, { one: 'function', other: 'functions' }),
                  extension ? 'extension' : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
          </ToolbarField>
          <ToolbarDivider />
          {codebase.worker.inspectPort !== null && <DebugChip port={codebase.worker.inspectPort} />}
          <Button
            variant="ghost"
            size="sm"
            icon={<PowerIcon />}
            onClick={() => setRestarting(true)}
            data-testid="codebase-restart"
          >
            Restart worker
          </Button>
          <ToolbarDivider />
          {extension ? (
            entry.instance ? (
              <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-kumo-subtle">
                Reloads in Extensions:{' '}
                <EntityLink entity={entry.instance} testId="codebase-instance" />
              </span>
            ) : null
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={<ArrowClockwiseIcon />}
              loading={reload.isPending}
              onClick={() => reload.mutate()}
              data-testid="codebase-reload-primary"
            >
              Reload
            </Button>
          )}
        </ToolbarRow>
      </SectionToolbar>
      <CodebaseBanners entry={entry} />
      <div className="flex min-h-0 flex-1 flex-col" data-testid="codebase-view">
        <div className="grid shrink-0 grid-cols-1 gap-3 p-3 lg:grid-cols-3">
          <WorkerCard entry={entry} />
          <LoadedCard entry={entry} />
          <EnvFilesCard entry={entry} onOpenFile={onOpenEnvironment} />
        </div>
        <LoadLog project={project} codebase={codebase.id} />
        {!extension &&
          codebase.state === 'ready' &&
          count === 0 &&
          codebase.notLoaded.length === 0 && (
            <Text variant="secondary" size="sm" DANGEROUS_className="px-3 py-2">
              {codebase.id} exports no functions.
            </Text>
          )}
      </div>
      <RestartWorkerDialog
        open={restarting}
        onOpenChange={setRestarting}
        codebase={codebase.id}
        inFlight={codebase.worker.inFlight}
      />
    </>
  )
}
