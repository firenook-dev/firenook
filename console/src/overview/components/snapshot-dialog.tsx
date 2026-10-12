// "Download a snapshot…" from ⌘K or a link (`?dialog=snapshot`): which
// services to include, then Download. The engine prepares it as a suite
// job and this tab downloads it when it is ready; the card's own button
// skips the dialog and includes every service.

import { Button, Dialog } from '@cloudflare/kumo'
import { DownloadSimpleIcon, XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { Job } from '@/api/generated/Job'
import { SnapshotTargets, listedLabels, snapshotServices } from './snapshot-targets'

export function SnapshotDialog({
  open,
  onOpenChange,
  status,
  running,
  starting,
  refusal,
  onStart,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: ConsoleStatus
  /** A suite job already running: nothing can start until it ends. */
  running: Job | undefined
  starting: boolean
  refusal: Error | undefined
  /** Starts the snapshot; resolves true once the engine has taken it. */
  onStart: (targets: readonly string[] | undefined) => Promise<boolean>
}) {
  const services = snapshotServices(status)
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(services))
  const chosen = services.filter((name) => checked.has(name))
  const all = chosen.length === services.length
  const close = (next: boolean) => {
    if (!next) setChecked(new Set(services))
    onOpenChange(next)
  }
  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog className="p-6 sm:w-[560px]">
        <div className="contents" data-testid="snapshot-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Download a snapshot</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            A zip of a standard export. Unzip it and start the engine with{' '}
            <span className="font-mono text-[0.9em] text-kumo-default">
              --import &lt;folder&gt;
            </span>{' '}
            to begin from this data again, on this machine or another.
          </Dialog.Description>
          <div className="mt-5">
            {services.length > 0 ? (
              <SnapshotTargets
                status={status}
                services={services}
                checked={checked}
                onChange={setChecked}
                disabled={starting}
                testId="snapshot-dialog-targets"
              />
            ) : (
              <p className="text-[14px] text-kumo-subtle">
                No service this engine runs keeps data a snapshot could hold.
              </p>
            )}
          </div>
          {refusal && (
            <p
              className="mt-3 text-[13px] text-kumo-danger"
              role="alert"
              data-testid="snapshot-dialog-error"
            >
              {refusal.message}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => close(false)}>
              Close
            </Button>
            <Button
              variant="primary"
              icon={<DownloadSimpleIcon />}
              loading={starting}
              disabled={chosen.length === 0 || running !== undefined}
              title={running ? `A data job is running: ${running.title}` : undefined}
              onClick={() =>
                void onStart(all ? undefined : chosen).then((taken) => {
                  if (taken) close(false)
                })
              }
              data-testid="snapshot-dialog-download"
            >
              {chosen.length === 0 || all ? 'Download' : `Download ${listedLabels(chosen)}`}
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
