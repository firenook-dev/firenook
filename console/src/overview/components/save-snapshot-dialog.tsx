// "Save on the engine's machine…": a standard export written by the engine
// to a folder it lists (`GET /suite/destinations`) — the export-on-exit
// folder, the import seed when that is safe, the project's export folder.
// The browser names a destination, never a path; any other folder is the
// `firenook emulators:export <dir>` command to run. A folder that already
// holds files is replaced only after a second, explicit confirmation.

import { Button, Dialog, Radio } from '@cloudflare/kumo'
import { FloppyDiskIcon, XIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, apiSend } from '@/api/client'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { ExportDestination } from '@/api/generated/ExportDestination'
import type { ExportResult } from '@/api/generated/ExportResult'
import type { Job } from '@/api/generated/Job'
import { CopyField } from '@/components/console/copy-button'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { formatDuration } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { destinationsQuery } from '../api'
import { SnapshotTargets, snapshotServices } from './snapshot-targets'

const EXPORT_COMMAND = 'firenook emulators:export <dir>'

/** The destination picked first: the first the engine will write to. */
function firstWritable(destinations: readonly ExportDestination[]): string | undefined {
  return destinations.find((destination) => destination.refused === undefined)?.id
}

export function SaveSnapshotDialog({
  open,
  onOpenChange,
  status,
  running,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: ConsoleStatus
  running: Job | undefined
}) {
  const client = useQueryClient()
  const destinations = useQuery({ ...destinationsQuery, enabled: open })
  const list = destinations.data ?? []
  const services = snapshotServices(status)
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(services))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [replacing, setReplacing] = useState<ExportDestination | undefined>(undefined)
  const destination = list.find((entry) => entry.id === (picked ?? firstWritable(list)))
  const chosen = services.filter((name) => checked.has(name))

  const close = (next: boolean) => {
    if (!next && saving) return
    if (!next) {
      setPicked(undefined)
      setChecked(new Set(services))
      setError(undefined)
      setReplacing(undefined)
    }
    onOpenChange(next)
  }

  const save = async (target: ExportDestination, overwrite: boolean) => {
    setSaving(true)
    setError(undefined)
    try {
      const result = await apiSend<ExportResult>('POST', '/suite/export', {
        destination: target.id,
        ...(chosen.length === services.length ? {} : { targets: chosen }),
        ...(overwrite ? { overwrite: true } : {}),
      })
      setReplacing(undefined)
      toast({
        key: 'overview-save-snapshot',
        title: 'Snapshot saved',
        description: `${result.path} · ${formatDuration(result.tookMs)}`,
        tone: 'success',
      })
      setSaving(false)
      close(false)
    } catch (thrown) {
      setSaving(false)
      if (thrown instanceof ApiError && thrown.code === 'already-exists' && !overwrite) {
        setReplacing(target)
        return
      }
      setReplacing(undefined)
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      void client.invalidateQueries({ queryKey: destinationsQuery.queryKey })
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog className="p-6 sm:w-[560px]">
        <div className="contents" data-testid="save-snapshot-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">
              Save a snapshot on the engine&apos;s machine
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              disabled={saving}
              render={
                <Button
                  variant="ghost"
                  shape="square"
                  icon={<XIcon />}
                  aria-label="Close"
                  disabled={saving}
                />
              }
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            Writes a standard export (
            <span className="font-mono text-[0.9em] text-kumo-default">
              firebase-export-metadata.json
            </span>{' '}
            and its data) that the engine imports with{' '}
            <span className="font-mono text-[0.9em] text-kumo-default">--import</span>.
          </Dialog.Description>

          <div className="mt-5 grid gap-5">
            <div className="grid gap-2">
              {destinations.isError ? (
                <p className="text-[13px] text-kumo-danger">{destinations.error.message}</p>
              ) : list.length > 0 ? (
                <Radio.Group
                  legend="Where"
                  value={destination?.id ?? ''}
                  onValueChange={(value) => {
                    setPicked(String(value))
                    setError(undefined)
                  }}
                  disabled={saving}
                  className="[&_legend]:text-[13px] [&_legend]:font-medium"
                >
                  {list.map((entry) => (
                    <Radio.Item
                      key={entry.id}
                      value={entry.id}
                      disabled={entry.refused !== undefined}
                      label={
                        <span
                          className="grid min-w-0 gap-0.5"
                          data-testid={`save-destination-${entry.id}`}
                        >
                          <span className="text-[14px]">{entry.label}</span>
                          <span
                            className="truncate font-mono text-[12px] text-kumo-subtle"
                            title={entry.path}
                          >
                            {entry.path}
                          </span>
                          {entry.refused && (
                            <span
                              className="text-[12px] text-kumo-subtle"
                              data-testid={`save-destination-${entry.id}-refused`}
                            >
                              {entry.refused}
                            </span>
                          )}
                        </span>
                      }
                    />
                  ))}
                </Radio.Group>
              ) : destinations.isPending ? (
                <div className="h-16" aria-busy />
              ) : (
                <p className="text-[13px] text-kumo-subtle">
                  This engine lists no folder to save to.
                </p>
              )}
              <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-kumo-subtle">
                Another folder: run
                <CopyField value={EXPORT_COMMAND} className="text-kumo-default" />
              </p>
            </div>

            {services.length > 0 && (
              <SnapshotTargets
                status={status}
                services={services}
                checked={checked}
                onChange={setChecked}
                disabled={saving}
                testId="save-snapshot-targets"
              />
            )}

            <p className="text-[13px] text-kumo-subtle">
              The folder is replaced as a whole once the new export is complete.
            </p>
          </div>

          {error && (
            <p
              className="mt-3 text-[13px] text-kumo-danger"
              role="alert"
              data-testid="save-snapshot-error"
            >
              {error}
            </p>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => close(false)} disabled={saving}>
              Close
            </Button>
            <Button
              variant="primary"
              icon={<FloppyDiskIcon />}
              loading={saving}
              disabled={
                destination === undefined ||
                destination.refused !== undefined ||
                chosen.length === 0 ||
                running !== undefined
              }
              title={running ? `A data job is running: ${running.title}` : undefined}
              onClick={() => destination && void save(destination, false)}
              data-testid="save-snapshot-confirm"
            >
              Save snapshot
            </Button>
          </div>
        </div>
        <DangerConfirm
          open={replacing !== undefined}
          onOpenChange={(next) => {
            if (!next) setReplacing(undefined)
          }}
          title="Replace the export"
          description={
            <>
              <span className="font-mono text-[0.9em] break-all text-kumo-default">
                {replacing?.path}
              </span>{' '}
              already holds files. They are replaced with what the engine holds now.
            </>
          }
          consequences={['The folder is swapped only once the new export is complete.']}
          pending={saving}
          onConfirm={() => replacing && void save(replacing, true)}
          testId="save-snapshot-replace"
        />
      </Dialog>
    </Dialog.Root>
  )
}
