// The engine itself, for debugging the emulator rather than the app: its
// build, when it started, where it listens, the files it read, where its
// data lives and how writes reach the disk, and the switches it was started
// with. Configuration comes from `/overview/engine` (fixed for the engine's
// run), data facts from the status the shell already holds. The top bar's
// engine badge leads here (`/#engine`).

import { Tooltip } from '@cloudflare/kumo'
import { ArrowSquareOutIcon } from '@phosphor-icons/react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { OverviewEngineDetails } from '@/api/generated/observe/OverviewEngineDetails'
import { CopyField } from '@/components/console/copy-button'
import { useNow } from '@/lib/clock'
import { clockOrDate } from '@/lib/format'
import { serviceLabel } from '@/lib/services'
import { uptime } from '../model'
import { SectionError } from './section-error'

/** What `--durability` means for a write, in words; a mode the console does not know says nothing. */
export function durabilityNote(durability: string): string | undefined {
  if (durability === 'write-behind')
    return 'a commit answers once journaled; the disk is synced every second and at shutdown'
  if (durability === 'per-commit') return 'each commit reaches the disk before it answers'
  return undefined
}

export function EngineDetails({
  status,
  details,
}: {
  status: ConsoleStatus
  details: UseQueryResult<OverviewEngineDetails>
}) {
  const now = useNow('minute')
  const { engine, data } = status
  const config = details.data?.config ?? null
  const writes = durabilityNote(data.durability)

  return (
    <section
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
            <span className="font-mono">{clockOrDate(status.startedAt, now)}</span>
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
            <span className={data.mode === 'memory' ? 'text-kumo-warning' : undefined}>
              {data.mode === 'memory' ? 'In memory' : 'On disk'}
            </span>
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
          {data.mode === 'disk' && (
            <Row label="Writes" testId="engine-writes">
              <span className="font-mono">{data.durability}</span>
              {writes && <Note>{writes}</Note>}
            </Row>
          )}
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
