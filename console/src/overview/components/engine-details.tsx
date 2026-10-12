// The engine itself, for debugging the emulator rather than the app: its
// build, when it started, where it listens, the files it read, where its
// data lives, the switches it was started with, and what the console's
// buffers cost. Configuration comes from `/overview/engine` (fixed for the
// engine's run), data facts from the status the shell already holds, and
// the buffers are read when this part of the page comes into view and on
// its refresh button — never on a timer.

import { Button, Tooltip } from '@cloudflare/kumo'
import { ArrowClockwiseIcon, ArrowSquareOutIcon } from '@phosphor-icons/react'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { MemoryReport } from '@/api/generated/MemoryReport'
import type { OverviewEngineDetails } from '@/api/generated/observe/OverviewEngineDetails'
import { CopyField } from '@/components/console/copy-button'
import { useNow } from '@/lib/clock'
import { formatBytes, formatNumber } from '@/lib/format'
import { serviceLabel } from '@/lib/services'
import { memoryQuery } from '../api'
import { uptime } from '../model'
import { SectionError } from './section-error'

/** What each buffer holds, in words; a buffer the console does not know keeps its name. */
const RING_LABELS: Record<string, string> = {
  logs: 'log lines',
  'logs.problems': 'problems kept longer',
  logging: 'official log feed',
  'firestore.changes': 'Firestore changes',
  jobs: 'jobs',
}

const pad = (value: number) => String(value).padStart(2, '0')

/** "12:02:41" today; with the date in front on another day. */
function startedAt(iso: string, now: number): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  if (date.toDateString() === new Date(now).toDateString()) return time
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

/** "18.2 MB of 64 MB" and each buffer holding anything, largest first. */
export function memoryRows(report: MemoryReport) {
  const used = report.rings.filter((ring) => ring.entries > 0).toSorted((a, b) => b.bytes - a.bytes)
  return {
    total: `${formatBytes(report.usedBytes)} of ${formatBytes(report.budgetBytes)}`,
    rings: used.map((ring) => ({
      name: ring.name,
      label: RING_LABELS[ring.name] ?? ring.name,
      size: formatBytes(ring.bytes),
      entries: ring.entries,
    })),
    empty: report.rings.length - used.length,
  }
}

export function EngineDetails({
  status,
  project,
  details,
}: {
  status: ConsoleStatus
  project: string
  details: UseQueryResult<OverviewEngineDetails>
}) {
  const now = useNow('minute')
  const section = useRef<HTMLElement>(null)
  // Without an IntersectionObserver (an old browser) the part counts as shown.
  const [shown, setShown] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const node = section.current
    if (!node || shown) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShown(true)
        observer.disconnect()
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [shown])
  const memory = useQuery({ ...memoryQuery(project), enabled: shown && project !== '' })
  const { engine, data } = status
  const config = details.data?.config ?? null

  return (
    <section
      ref={section}
      id="overview-engine"
      className="grid gap-3"
      aria-labelledby="overview-engine-title"
      data-testid="overview-engine-details"
    >
      <h2 id="overview-engine-title" className="text-lg font-semibold">
        Engine
      </h2>
      <div className="overflow-hidden rounded-lg bg-kumo-base shadow-xs ring ring-kumo-line">
        {details.isError ? (
          <SectionError
            error={details.error}
            onRetry={() => void details.refetch()}
            testId="overview-engine-error"
          />
        ) : null}
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-8 gap-y-2.5 px-5 py-4">
          <Row label="Version" testId="engine-version">
            <span className="font-mono">{engine.version ?? 'unreleased build'}</span>
            {engine.revision ? (
              <>
                <Sep />
                <span className="text-kumo-subtle">engine source</span>
                <CopyField value={engine.revision} className="text-kumo-default">
                  {engine.revision.slice(0, 12)}
                </CopyField>
              </>
            ) : (
              <Note>run straight from a build, so it has no release to name</Note>
            )}
          </Row>
          <Row label="Running since" testId="engine-started">
            <span className="font-mono">{startedAt(status.startedAt, now)}</span>
            <Note>{uptime(status.startedAt, now)}</Note>
          </Row>
          {config && (
            <Row label="Listening on" testId="engine-host">
              <span className="font-mono">{config.host}</span>
              {config.connectHost !== config.host && (
                <Note>
                  clients connect to <span className="font-mono">{config.connectHost}</span>
                </Note>
              )}
            </Row>
          )}
          {config && (
            <Row label="Project folder" testId="engine-project-dir">
              <Path value={config.projectDir} />
            </Row>
          )}
          {config && (
            <Row label="firebase.json" testId="engine-firebase-json">
              <Path value={config.firebaseJson} />
            </Row>
          )}
          <Row label="Data" testId="engine-data">
            <span>{data.mode === 'memory' ? 'In memory' : 'On disk'}</span>
            <Sep />
            <span className="font-mono">{data.durability}</span>
            {data.resumed && (
              <>
                <Sep />
                <span>resumed</span>
              </>
            )}
            {data.stateDir ? (
              <>
                <Sep />
                <Path value={data.stateDir} />
              </>
            ) : (
              <Note>gone when the engine stops</Note>
            )}
          </Row>
          {data.importedFrom && (
            <Row label="Import seed" testId="engine-import">
              <Path value={data.importedFrom} />
            </Row>
          )}
          {data.exportOnExit && (
            <Row label="Export on exit" testId="engine-export-on-exit">
              <Path value={data.exportOnExit} />
            </Row>
          )}
          {config && (
            <Row label="Diagnostics" testId="engine-diagnostics">
              <span>{config.diagnostics ? 'On' : 'Off'}</span>
              <Note>
                {config.diagnostics
                  ? 'Requests and coverage keep decoded values'
                  : 'started with --no-diagnostics; the rules pages show no requests'}
              </Note>
            </Row>
          )}
          {config && (
            <Row label="Single project mode" testId="engine-single-project">
              <span>{config.singleProjectMode ? 'On' : 'Off'}</span>
              <Note>
                {config.singleProjectMode
                  ? 'requests for another project id are warned about'
                  : 'requests for another project id are served silently'}
              </Note>
            </Row>
          )}
          {config && (
            <Row label="Offline" testId="engine-offline">
              <span>{config.offline ? 'On' : 'Off'}</span>
              <Note>
                {config.offline
                  ? 'the Extensions registry is never contacted'
                  : 'Extensions sources may be fetched from their registry'}
              </Note>
            </Row>
          )}
          {config && config.selected.length > 0 && (
            <Row label="Started with --only" testId="engine-only">
              <span className="font-mono">{config.selected.join(',')}</span>
              <Note>{config.selected.map(serviceLabel).join(', ')}</Note>
            </Row>
          )}
          {config && (
            <Row label="Debug log" testId="engine-debug-log">
              {config.debugLog ? (
                <Path value={config.debugLog} />
              ) : (
                <>
                  <span>Off</span>
                  <Note>
                    start with <span className="font-mono">--debug-log &lt;file&gt;</span> to keep
                    every line on disk
                  </Note>
                </>
              )}
            </Row>
          )}
          {config && (
            <Row label="Node" testId="engine-node">
              <Path value={config.node} />
            </Row>
          )}
          <Row label="Console buffers" testId="engine-memory">
            <Memory memory={memory} />
            <Tooltip
              content="Read the buffers again"
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  shape="square"
                  icon={<ArrowClockwiseIcon />}
                  aria-label="Read the buffers again"
                  loading={memory.isFetching}
                  onClick={() => void memory.refetch()}
                  className="self-center"
                  data-testid="engine-memory-refresh"
                />
              }
            />
          </Row>
          <Row label="Google Emulator UI" testId="engine-google-ui">
            <a
              href="/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-kumo-link underline-offset-2 hover:underline"
            >
              Open
              <ArrowSquareOutIcon size={12} aria-hidden />
            </a>
            <Note>still served at the root of this port until the console covers everything</Note>
          </Row>
        </dl>
      </div>
    </section>
  )
}

function Row({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[13px] text-kumo-subtle">{label}</dt>
      <dd
        className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] text-kumo-default"
        data-testid={testId}
      >
        {children}
      </dd>
    </>
  )
}

function Sep() {
  return (
    <span aria-hidden className="text-kumo-subtle">
      ·
    </span>
  )
}

/** The English after a value, quieter than it. */
function Note({ children }: { children: ReactNode }) {
  return <span className="text-kumo-subtle">({children})</span>
}

/** A path: copyable whole, cut at the end when narrow, the whole of it in the tooltip. */
function Path({ value }: { value: string }) {
  return (
    <Tooltip
      content={<span className="font-mono text-[12px] break-all">{value}</span>}
      render={
        <span className="flex max-w-full min-w-0 self-center">
          <CopyField value={value} className="text-kumo-default" />
        </span>
      }
    />
  )
}

function Memory({ memory }: { memory: UseQueryResult<MemoryReport> }) {
  if (memory.isError) return <span className="text-kumo-danger">{memory.error.message}</span>
  if (!memory.data) return <span className="text-kumo-subtle">…</span>
  const rows = memoryRows(memory.data)
  return (
    <>
      <span className="font-mono tabular-nums">{rows.total}</span>
      {rows.rings.map((ring) => (
        <Tooltip
          key={ring.name}
          content={`${ring.name}: ${formatNumber(ring.entries)} ${ring.entries === 1 ? 'entry' : 'entries'}`}
          render={
            <span className="inline-flex items-baseline gap-1" data-ring={ring.name}>
              <Sep />
              <span className="text-kumo-subtle">{ring.label}</span>
              <span className="font-mono tabular-nums">{ring.size}</span>
            </span>
          }
        />
      ))}
      {rows.empty > 0 && (
        <span className="text-kumo-subtle">
          <Sep /> {rows.empty} empty
        </span>
      )}
    </>
  )
}
