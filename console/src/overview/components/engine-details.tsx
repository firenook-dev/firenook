// The engine itself, for debugging the emulator rather than the app. At
// rest the card holds what is asked most — the build, when it started, the
// project folder, where its data lives and how writes reach the disk — and
// "Show all" opens the rest in place: where it listens, the ports no
// section owns (the hub a harness finds the emulators by, this UI, the
// official logging and requests sockets), the files it read, and the
// switches it was started with. Configuration comes from `/overview/engine`
// (fixed for the engine's run), data facts from the status the shell
// already holds. The engine's version at the navigation's foot leads here
// (`/#engine`), as does the top bar's live badge when it shows, and opens
// it whole.

import { Button, Tooltip } from '@cloudflare/kumo'
import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react'
import type { UseQueryResult } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { OverviewEngineDetails } from '@/api/generated/observe/OverviewEngineDetails'
import { CopyField } from '@/components/console/copy-button'
import { useOverviewAsks } from '@/components/shell/overview-parts'
import { useNow } from '@/lib/clock'
import { clockOrDate } from '@/lib/format'
import { serviceLabel } from '@/lib/services'
import { infrastructure, shortPath, uptime } from '../model'
import { SectionError } from './section-error'

/** What `--durability` means for a write, in words; a mode the console does not know says nothing. */
export function durabilityNote(durability: string): string | undefined {
  if (durability === 'write-behind')
    return 'a commit answers once journaled; the disk is synced every second and at shutdown'
  if (durability === 'per-commit') return 'each commit reaches the disk before it answers'
  return undefined
}

/** Whether the card opens whole: the address names it (`/#engine`), or it is asked for while open. */
function useOpenedWhole(): [boolean, (open: boolean) => void] {
  const [all, setAll] = useState(() => window.location.hash === '#engine')
  useEffect(
    () =>
      useOverviewAsks.subscribe((state, previous) => {
        if (state.asks !== previous.asks && state.part === 'engine') setAll(true)
      }),
    [],
  )
  return [all, setAll]
}

export function EngineDetails({
  status,
  details,
}: {
  status: ConsoleStatus
  details: UseQueryResult<OverviewEngineDetails>
}) {
  const now = useNow('minute')
  const [all, setAll] = useOpenedWhole()
  const { engine, data } = status
  const config = details.data?.config ?? null
  const writes = durabilityNote(data.durability)
  const ports = infrastructure(status)

  return (
    <section
      id="overview-engine"
      className="grid content-start gap-3"
      aria-labelledby="overview-engine-title"
      data-testid="overview-engine-details"
      data-all={all}
    >
      <div className="flex h-8 min-w-0 items-center justify-between gap-3">
        <h2 id="overview-engine-title" className="text-[16px] leading-6 font-semibold">
          Engine
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAll(!all)}
          aria-expanded={all}
          aria-controls="overview-engine-rows"
          data-testid="overview-engine-all"
        >
          <span className="flex items-center gap-1.5">
            {all ? 'Show less' : 'Show all'}
            {all ? <CaretUpIcon size={12} aria-hidden /> : <CaretDownIcon size={12} aria-hidden />}
          </span>
        </Button>
      </div>
      <div className="min-w-0 overflow-hidden rounded-lg bg-kumo-base shadow-xs ring ring-kumo-line">
        {details.isError ? (
          <SectionError
            error={details.error}
            onRetry={() => void details.refetch()}
            testId="overview-engine-error"
          />
        ) : null}
        <dl
          id="overview-engine-rows"
          className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2.5 px-5 py-4"
        >
          <Row label="Version" testId="engine-version">
            <span className="font-mono">{engine.version ?? 'unreleased build'}</span>
            {engine.revision ? (
              <>
                <Sep />
                <Tooltip
                  content="The engine's source revision"
                  render={
                    <span className="flex min-w-0">
                      <CopyField value={engine.revision} className="text-kumo-subtle">
                        {engine.revision.slice(0, 12)}
                      </CopyField>
                    </span>
                  }
                />
              </>
            ) : (
              <Note>run straight from a build, so it has no release to name</Note>
            )}
          </Row>
          <Row label="Started" testId="engine-started">
            <span className="font-mono">{clockOrDate(status.startedAt, now)}</span>
            <Note>{uptime(status.startedAt, now)} ago</Note>
          </Row>
          {config && (
            <Row label="Project folder" testId="engine-project-dir">
              <Path value={config.projectDir} />
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
              <span className="flex basis-full min-w-0">
                <Path value={data.stateDir} />
              </span>
            ) : (
              <Note>gone when the engine stops</Note>
            )}
          </Row>
          {data.mode === 'disk' && (
            <Row label="Writes" testId="engine-writes">
              {writes ? (
                <Tooltip
                  content={writes.charAt(0).toUpperCase() + writes.slice(1)}
                  render={<span className="font-mono">{data.durability}</span>}
                />
              ) : (
                <span className="font-mono">{data.durability}</span>
              )}
            </Row>
          )}

          {all && (
            <>
              <Divider />
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
              {ports.length > 0 && (
                <Row label="Other ports" testId="overview-infrastructure">
                  <span className="grid grid-cols-[max-content_max-content] items-baseline gap-x-4 gap-y-1">
                    {ports.map((entry) => (
                      <span key={entry.name} className="contents" data-service={entry.name}>
                        <Tooltip
                          content={entry.about}
                          render={<span className="text-kumo-subtle">{entry.label}</span>}
                        />
                        <CopyField value={entry.address} className="text-kumo-default">
                          {entry.address.slice(entry.address.lastIndexOf(':'))}
                        </CopyField>
                      </span>
                    ))}
                  </span>
                </Row>
              )}
              {config && (
                <Row label="firebase.json" testId="engine-firebase-json">
                  <Path value={config.firebaseJson} />
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
                      ? 'requests and coverage keep decoded values'
                      : 'started with --no-diagnostics; the rules pages show no requests'}
                  </Note>
                </Row>
              )}
              {config && (
                <Row label="Single project" testId="engine-single-project">
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
                        start with <span className="font-mono">--debug-log &lt;file&gt;</span> to
                        keep every line on disk
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
            </>
          )}
        </dl>
      </div>
    </section>
  )
}

/** A hairline across both columns: what the card holds at rest above it, the rest below. */
function Divider() {
  return <div className="col-span-2 my-1 border-t border-kumo-hairline" aria-hidden />
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

/** A path: copyable whole, its middle taken out to fit, the whole of it in the tooltip. */
function Path({ value }: { value: string }) {
  return (
    <Tooltip
      content={<span className="font-mono text-[12px] break-all">{value}</span>}
      render={
        <span className="flex max-w-full min-w-0 self-center" data-path={value}>
          <CopyField value={value} className="text-kumo-default">
            {shortPath(value)}
          </CopyField>
        </span>
      }
    />
  )
}
