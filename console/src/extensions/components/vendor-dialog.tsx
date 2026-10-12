// Vendoring a registry extension, exactly as `firenook ext:vendor` does it:
// its source copied into the project's `extensions/.sources`, the version
// recorded, and the instance reloaded from the copy, so it starts on a
// machine with no network. The dialog says where it goes and when the
// network is needed before it is done, and where it went after.

import { Button, Dialog, Text } from '@cloudflare/kumo'
import { CheckCircleIcon, XIcon } from '@phosphor-icons/react'
import type { ExtensionInstanceSummary } from '@/api/generated/compute/ExtensionInstanceSummary'
import type { ExtensionVendorResult } from '@/api/generated/compute/ExtensionVendorResult'
import { failureText } from '../actions'

/** Where `firenook ext:vendor` puts a source, relative to the project. */
export const VENDOR_DIRECTORY = 'extensions/.sources'

export function VendorDialog({
  open,
  onOpenChange,
  summary,
  pending,
  result,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  summary: ExtensionInstanceSummary
  pending: boolean
  result: ExtensionVendorResult | undefined
  error: unknown
  onConfirm: () => void
}) {
  const failure = error ? failureText(error) : undefined
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return
        onOpenChange(next)
      }}
    >
      <Dialog size="base" className="p-6">
        <div className="contents" data-testid="vendor-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">
              Vendor {summary.instanceId} for offline use
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              disabled={pending}
              render={
                <Button
                  variant="ghost"
                  shape="square"
                  icon={<XIcon />}
                  aria-label="Close"
                  disabled={pending}
                />
              }
            />
          </div>
          {result ? (
            <div className="grid gap-2" data-testid="vendor-result">
              <span className="flex items-center gap-2 text-[14px] text-kumo-default">
                <CheckCircleIcon size={16} className="shrink-0 text-kumo-success" />
                Vendored version <span className="font-mono text-[12px]">{result.version}</span>
              </span>
              <Text variant="secondary" size="sm">
                The source is in{' '}
                <span className="font-mono text-[0.9em] text-kumo-default">{result.directory}</span>{' '}
                and the instance now loads from it. Commit the directory so everyone starts offline.
              </Text>
            </div>
          ) : (
            <>
              <Dialog.Description className="text-kumo-subtle">
                Copies the source of{' '}
                <span className="font-mono text-[0.9em] text-kumo-default">
                  {summary.reference ?? summary.written}
                </span>{' '}
                into <span className="font-mono text-[0.9em]">{VENDOR_DIRECTORY}</span>, records its
                version and reloads the instance from the copy, as{' '}
                <span className="font-mono text-[0.9em]">firenook ext:vendor</span> does.
              </Dialog.Description>
              <p className="mt-3 mb-0 text-[14px] text-kumo-subtle">
                Needs network only when the source is not in the shared cache.
              </p>
            </>
          )}
          {failure && (
            <div
              className="mt-3 grid gap-1 rounded-md bg-kumo-danger-tint px-3 py-2"
              role="alert"
              data-testid="vendor-error"
            >
              <Text variant="error" size="sm">
                {failure.title}
              </Text>
              {failure.description && (
                <Text variant="secondary" size="sm">
                  {failure.description}
                </Text>
              )}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            {result ? (
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={onConfirm}
                  loading={pending}
                  data-testid="vendor-confirm"
                >
                  Vendor
                </Button>
              </>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
