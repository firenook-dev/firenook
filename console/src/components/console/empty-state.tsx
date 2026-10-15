// Honest states, with no flash (foundation §4.8): nothing exists yet, the
// filter matches nothing, the request failed, the first page is on its way.
// Each says what is true and offers the one thing to do about it.

import { Button, Empty, SkeletonLine } from '@cloudflare/kumo'
import { FunnelIcon, type Icon, LockKeyIcon, WarningIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import { statusQuery } from '@/api/queries'
import { connectDialects } from '@/lib/connect'
import type { ConnectParam } from '@/lib/connect-tabs'
import { type SectionId, sectionById } from '@/lib/services'
import { CodeBlock } from './code-block'
import { ServiceStarting, sectionStatus } from './section-gate'
import { CHECK_WIDTH, ROW_HEIGHT } from './table-pins'

/** True once `on` has held for `delayMs`: a loading state that does not flash for a fast answer. */
export function useDelayedFlag(on: boolean, delayMs = 150): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!on) return undefined
    const timer = setTimeout(() => setLate(true), delayMs)
    return () => {
      clearTimeout(timer)
      setLate(false)
    }
  }, [on, delayMs])
  return on && late
}

/** The snippets an empty section shows, of the one tab list (`lib/connect-tabs.ts`). */
export const EMPTY_CONNECT: readonly ConnectParam[] = ['web', 'node', 'python', 'go']

/**
 * Nothing exists yet. It says how things get here from the app first — the
 * connection snippet with this engine's host, port and project id, and that
 * the app is writing to another project when the engine has seen it do so —
 * then offers the console's own way in (a primary button among `actions`).
 */
export function EmptyState({
  icon: Glyph,
  title,
  description,
  commandLine,
  actions,
  connect,
  testId = 'empty-state',
}: {
  icon: Icon
  title: string
  description?: string | undefined
  /** One command to copy ("firebase deploy --only storage"). */
  commandLine?: string | undefined
  actions?: ReactNode
  /**
   * The service whose connection snippet to show (`auth`, `storage`,
   * `pubsub`…), and the project the page shows when it is another one than
   * the emulator's (`?project=`): the app's other project is then on screen,
   * so the "not shown here" line is left out.
   */
  connect?: { service: string; project?: string | undefined } | undefined
  testId?: string
}) {
  const status = useQuery(statusQuery)
  const service = connect?.service
  const running =
    service !== undefined && status.data?.services.some((entry) => entry.name === service)
  const shown = connect?.project ?? status.data?.projectId
  const foreign =
    service === undefined
      ? undefined
      : status.data?.foreignProjects.find(
          (project) => project.services.includes(service) && project.projectId !== shown,
        )
  const contents = (
    <div className="grid w-[min(560px,100%)] justify-items-center gap-4">
      {foreign && status.data && (
        <p className="text-[13px] text-kumo-default" data-testid={`${testId}-foreign`}>
          Your app is using project{' '}
          <span className="font-mono text-[0.9em]">{foreign.projectId}</span>; this emulator is{' '}
          <span className="font-mono text-[0.9em]">{status.data.projectId}</span>, so what it writes
          is not shown here.
        </p>
      )}
      {running && status.data && service !== undefined && (
        <div className="w-full text-left">
          <CodeBlock
            label="From your app"
            dialects={connectDialects(status.data, {
              services: [service],
              params: EMPTY_CONNECT,
            })}
            testId={`${testId}-connect`}
          />
        </div>
      )}
      {actions && <div className="flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  )
  return (
    // Kumo's command line draws a raw `border-white`, a bright frame in dark
    // mode; it takes the surface's own colour, and its ring is the edge.
    <div
      className="min-h-0 flex-1 overflow-auto [&_.border-white]:border-kumo-overlay"
      data-testid={testId}
    >
      <Empty
        icon={<Glyph size={48} className="text-kumo-inactive" />}
        title={title}
        {...(description === undefined ? {} : { description })}
        {...(commandLine === undefined ? {} : { commandLine })}
        contents={running || foreign || actions ? contents : undefined}
      />
    </div>
  )
}

/** The filter matches nothing: it is named, in the data face, with the way out. */
export function NoMatch({
  filter,
  onClear,
  noun,
  children,
  testId = 'no-match',
}: {
  filter: string
  onClear: () => void
  /** Plural: "users". */
  noun: string
  /** What else the page can say about why (Logs: which filter hides how many lines), under the filter. */
  children?: ReactNode
  testId?: string
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid={testId}>
      <Empty
        icon={<FunnelIcon size={48} className="text-kumo-inactive" />}
        title={`No ${noun} match`}
        description="Loosen a term or clear it."
        contents={
          <div className="grid justify-items-center gap-3">
            {filter.trim() !== '' && (
              <span className="max-w-[560px] rounded-md bg-kumo-tint px-2 py-1 font-mono text-[12px] break-words text-kumo-default">
                {filter}
              </span>
            )}
            {children}
            <Button variant="secondary" onClick={onClear} data-testid="no-match-clear">
              Clear the filter
            </Button>
          </div>
        }
      />
    </div>
  )
}

/**
 * A request failed: the engine's message as the title and its fix under it,
 * with Retry. A section that is still starting is not an error: it shows the
 * section's starting state and retries by itself once the section is ready.
 */
export function QueryError({
  error,
  onRetry,
  section,
}: {
  error: unknown
  onRetry: () => void
  section?: SectionId | undefined
}) {
  const status = useQuery(statusQuery)
  const api = error instanceof ApiError ? error : undefined
  const entry = section === undefined ? undefined : sectionById(section)
  const state =
    section === undefined ? undefined : sectionStatus(status.data?.sections, section).state
  const waiting = api?.code === 'starting' && entry !== undefined
  // Starting → ready: ask again once, by itself.
  const retried = useRef(false)
  useEffect(() => {
    if (waiting && state === 'ready' && !retried.current) {
      retried.current = true
      onRetry()
    }
  }, [waiting, state, onRetry])
  if (waiting && entry && section !== undefined)
    return (
      <ServiceStarting section={entry} status={sectionStatus(status.data?.sections, section)} />
    )
  const denied = api?.code === 'permission-denied'
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="query-error">
      <Empty
        icon={
          denied ? (
            <LockKeyIcon size={48} className="text-kumo-inactive" />
          ) : (
            <WarningIcon size={48} className="text-kumo-inactive" />
          )
        }
        title={api ? api.message : 'The request failed'}
        {...(api?.fix
          ? { description: api.fix }
          : api
            ? {}
            : { description: message || 'The engine did not answer.' })}
        contents={
          <Button variant="secondary" onClick={onRetry} data-testid="query-error-retry">
            Retry
          </Button>
        }
      />
    </div>
  )
}

/**
 * The first page on its way: the table's own 32 px rows with a line per
 * cell, shown only once the wait passes 150 ms so a fast answer never
 * flashes it.
 */
export function TableSkeleton({
  columns,
  rows = 8,
  check = false,
}: {
  columns: readonly { width: number }[]
  rows?: number
  /** Leave room for a check column, as the table it stands in for has. */
  check?: boolean
}) {
  const shown = useDelayedFlag(true)
  if (!shown) return null
  // Placeholders have no identity of their own: their place is their name.
  const cells = columns.map((column, place) => ({ name: `cell-${place}`, width: column.width }))
  const lines = Array.from({ length: rows }, (_, place) => `line-${place}`)
  return (
    <div className="min-h-0 flex-1 overflow-hidden" aria-busy data-testid="table-skeleton">
      {lines.map((line) => (
        <div
          key={line}
          className="flex items-center border-b border-kumo-hairline"
          style={{ height: ROW_HEIGHT }}
          aria-hidden
        >
          {check && <span className="shrink-0" style={{ width: CHECK_WIDTH }} />}
          {cells.map((cell) => (
            <span key={cell.name} className="shrink-0 px-3" style={{ width: cell.width }}>
              <SkeletonLine minWidth={40} maxWidth={90} />
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
