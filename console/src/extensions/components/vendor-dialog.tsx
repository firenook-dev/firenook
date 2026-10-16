// Vendoring a registry extension is the CLI's job: `firenook ext:vendor`
// copies its source into the project's `extensions/.sources` and records
// the version, so the instance starts on a machine with no network. The
// dialog gives the command for this instance to copy and run in the
// project, then Reload loads the instance from the copy.

import { Button, Dialog, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import type { ExtensionInstanceSummary } from '@/api/generated/compute/ExtensionInstanceSummary'
import { CodeBlock } from '@/components/console/code-block'

/** Where `firenook ext:vendor` puts a source, relative to the project. */
export const VENDOR_DIRECTORY = 'extensions/.sources'

/** The command that vendors one instance, run in the project's directory. */
export function vendorCommand(instance: string): string {
  return `firenook ext:vendor --instance ${instance}`
}

export function VendorDialog({
  open,
  onOpenChange,
  summary,
  reloading,
  onReload,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  summary: ExtensionInstanceSummary
  reloading: boolean
  /** Loads the instance again; the page says how it went. */
  onReload: () => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="p-6">
        <div className="contents" data-testid="vendor-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">
              Vendor {summary.instanceId} for offline use
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            Copies the source of{' '}
            <span className="font-mono text-[0.9em] text-kumo-default">
              {summary.reference ?? summary.written}
            </span>{' '}
            into <span className="font-mono text-[0.9em]">{VENDOR_DIRECTORY}</span> and records its
            version. Run it in your project's directory; it needs the network only when the source
            is not in the shared cache.
          </Dialog.Description>
          <div className="mt-4">
            <CodeBlock
              label="Run in your project"
              code={vendorCommand(summary.instanceId)}
              language="shell"
              testId="vendor-command"
            />
          </div>
          <Text variant="secondary" size="sm" DANGEROUS_className="mt-3 block">
            Then reload the instance: it loads from the copy. Commit the directory so everyone
            starts offline.
          </Text>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              variant="primary"
              onClick={onReload}
              loading={reloading}
              data-testid="vendor-reload"
            >
              Reload {summary.instanceId}
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
