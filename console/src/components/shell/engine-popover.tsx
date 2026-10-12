// What the engine badge opens (foundation spec §5.6): the engine's build,
// where its data lives and whether it survives a restart — the one place
// the shell draws those facts — and "Export now" to a folder the engine
// lists. The browser names a destination, never a path. Loaded the first
// time the badge is clicked; nothing in a page needs it to start.

import { Button, Dialog, DropdownMenu, InlineCopyText, Popover, Text } from '@cloudflare/kumo'
import { DownloadSimpleIcon, XIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactElement, ReactNode } from 'react'
import { useState } from 'react'
import { ApiError, apiGet, apiSend } from '@/api/client'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { DataFacts } from '@/api/generated/DataFacts'
import type { ExportDestination } from '@/api/generated/ExportDestination'
import type { ExportResult } from '@/api/generated/ExportResult'
import { statusQuery } from '@/api/queries'
import { PanelTitle } from '@/components/kit'
import { engineVersion } from '@/lib/engine'
import { formatDuration } from '@/lib/format'
import { toast } from '@/lib/toasts'

export const destinationsQuery = {
  queryKey: ['suite', 'destinations'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    apiGet<ExportDestination[]>('/suite/destinations', undefined, signal),
}

/** "on disk · resumed", "in memory · gone when the engine stops". */
export function describeData(data: DataFacts): string {
  if (data.mode === 'memory') return 'in memory · gone when the engine stops'
  return data.resumed ? 'on disk · resumed' : 'on disk'
}

export function EnginePopover({
  open,
  onOpenChange,
  trigger,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The badge, which stays the popover's trigger. */
  trigger: ReactElement
}) {
  const status = useQuery(statusQuery)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger render={trigger} />
      <Popover.Content align="end" className="w-[320px] max-w-[calc(100vw-2rem)] p-0">
        {status.data ? <Facts status={status.data} /> : <div className="p-4" />}
      </Popover.Content>
    </Popover>
  )
}

function Facts({ status }: { status: ConsoleStatus }) {
  const { engine, data } = status
  return (
    <div className="grid" data-testid="engine-popover">
      <div className="border-b border-kumo-line px-4 py-3">
        <PanelTitle>
          Engine {engineVersion(engine)}
          {engine.revision ? (
            <span className="font-normal text-kumo-subtle">
              {' '}
              · rev {engine.revision.slice(0, 7)}
            </span>
          ) : null}
        </PanelTitle>
      </div>
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 px-4 py-3 text-[12px]">
        <Row label="Data">
          <span
            className={data.mode === 'memory' ? 'text-kumo-warning' : 'text-kumo-default'}
            data-testid="engine-data-mode"
          >
            {describeData(data)}
          </span>
        </Row>
        {data.stateDir && (
          <Row label="State">
            <Path value={data.stateDir} testId="engine-state-dir" />
          </Row>
        )}
        {data.importedFrom && (
          <Row label="Imported">
            <Path value={data.importedFrom} />
          </Row>
        )}
        {data.exportOnExit && (
          <Row label="On exit">
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="shrink-0 text-kumo-subtle">exports to</span>
              <Path value={data.exportOnExit} />
            </span>
          </Row>
        )}
        <Row label="Writes">
          <span className="font-mono">{data.durability}</span>
        </Row>
      </dl>
      <div className="border-t border-kumo-line px-4 py-3">
        <ExportNow />
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-kumo-subtle">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

/**
 * A path as the popover has room for it: the end, which names the folder,
 * kept whole (`…/firenook-export/state`); the whole path is copied and is
 * the tooltip.
 */
export function shortPath(path: string, room = 34): string {
  if (path.length <= room) return path
  const parts = path.split(/[\\/]/).filter(Boolean)
  let tail = parts.pop() ?? path
  while (parts.length > 0 && tail.length + (parts.at(-1)?.length ?? 0) + 3 <= room)
    tail = `${parts.pop()}/${tail}`
  return `…/${tail}`
}

function Path({ value, testId }: { value: string; testId?: string }) {
  return (
    <span className="block min-w-0 truncate" title={value} data-testid={testId}>
      <InlineCopyText value={value} variant="body" size="xs" className="font-mono">
        {shortPath(value)}
      </InlineCopyText>
    </span>
  )
}

/** "Export now", to one of the folders the engine lists; a folder that holds files asks first. */
function ExportNow() {
  const client = useQueryClient()
  const destinations = useQuery(destinationsQuery)
  const [running, setRunning] = useState<string | undefined>(undefined)
  const [replacing, setReplacing] = useState<ExportDestination | undefined>(undefined)
  const run = async (destination: ExportDestination, overwrite: boolean) => {
    setRunning(destination.id)
    try {
      const result = await apiSend<ExportResult>('POST', '/suite/export', {
        destination: destination.id,
        ...(overwrite ? { overwrite: true } : {}),
      })
      toast({
        key: 'suite-export',
        title: `Exported to ${destination.label.toLowerCase()}`,
        description: `${result.path} · ${formatDuration(result.tookMs)}`,
        tone: 'success',
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'already-exists' && !overwrite) {
        setReplacing(destination)
        return
      }
      toast({
        key: 'suite-export',
        title: 'The export did not run',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setRunning(undefined)
      void client.invalidateQueries({ queryKey: destinationsQuery.queryKey })
    }
  }
  const list = destinations.data ?? []
  return (
    <div className="grid gap-1.5">
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button
              variant="secondary"
              size="sm"
              icon={<DownloadSimpleIcon />}
              loading={running !== undefined}
              disabled={destinations.isPending || list.length === 0}
              data-testid="export-now"
            >
              Export now
            </Button>
          }
        />
        <DropdownMenu.Content align="start" className="w-[288px]">
          {list.map((destination) => (
            <DropdownMenu.Item
              key={destination.id}
              disabled={destination.refused !== undefined}
              className="items-start"
              onClick={() => void run(destination, false)}
              data-testid={`export-to-${destination.id}`}
            >
              <span className="grid min-w-0 gap-0.5">
                <span>{destination.label}</span>
                <span className="truncate font-mono text-[12px] text-kumo-subtle">
                  {destination.refused ?? destination.path}
                </span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu>
      <Text variant="secondary" size="xs">
        {destinations.isError
          ? destinations.error.message
          : list.length === 0 && !destinations.isPending
            ? 'This engine lists no export folder. Export anywhere with firenook emulators:export <dir>.'
            : 'What the emulator writes on exit, now. To any other folder: firenook emulators:export <dir>.'}
      </Text>
      <Dialog.Root
        open={replacing !== undefined}
        onOpenChange={(next) => !next && setReplacing(undefined)}
      >
        <Dialog size="base" className="p-6">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Replace the export?</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            <span className="font-mono text-[0.9em]">{replacing?.path}</span> already holds files.
            Exporting replaces them with what the engine holds now.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReplacing(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="export-replace"
              onClick={() => {
                const target = replacing
                setReplacing(undefined)
                if (target) void run(target, true)
              }}
            >
              Replace
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  )
}
