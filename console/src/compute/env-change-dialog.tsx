// What a Save writes before it writes it: each file, and in it each value
// from what it is to what it will be, secrets masked, then what the reload
// does to calls in flight. Extensions' configuration and a codebase's
// environment both change files the same way (the engine writes them
// atomically and puts every byte back when the reload fails), so they say
// it the same way. A failed load is said here, in the dialog that asked for
// it, with the engine's own words: the files are already back.

import { Button, Dialog, Text } from '@cloudflare/kumo'
import { ArrowRightIcon, XIcon } from '@phosphor-icons/react'

/** One value a save changes, as the dialog lists it. */
export interface EnvChange {
  key: string
  /** The value now, or null when the file does not set it (or it is a secret). */
  before: string | null
  /** The value it will have, or null when the save removes the key. */
  after: string | null
  secret: boolean
}

/** One file a save writes. */
export interface EnvFileChange {
  /** Relative to the project: `extensions/greeter.env`, `functions/.env.local`. */
  file: string
  changes: readonly EnvChange[]
}

/** How a secret shows in the diff: its shape, never its value. */
const MASK = '••••••'

/** The dialog's one-line count: "2 values in 1 file". */
export function changeCount(files: readonly EnvFileChange[]): string {
  const values = files.reduce((sum, file) => sum + file.changes.length, 0)
  return `${values} ${values === 1 ? 'value' : 'values'} in ${files.length} ${
    files.length === 1 ? 'file' : 'files'
  }`
}

export function EnvChangeDialog({
  open,
  onOpenChange,
  title,
  files,
  note,
  pending,
  error,
  onConfirm,
  testId = 'env-change-dialog',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** "Save greeter's configuration". */
  title: string
  files: readonly EnvFileChange[]
  /** What happens after the write: "The instance reloads; calls in flight to its worker are dropped." */
  note: string
  pending: boolean
  /** The engine's refusal: its message and its fix (for a failed load, the first line of the load error). */
  error?: { message: string; fix?: string | undefined } | undefined
  onConfirm: () => void
  testId?: string
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // A save under way finishes or fails before the dialog goes.
        if (!next && pending) return
        onOpenChange(next)
      }}
    >
      <Dialog className="p-6 sm:w-[720px]">
        <div className="contents" data-testid={testId}>
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
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
          <Dialog.Description className="text-kumo-subtle">
            {changeCount(files)}, written to disk at once and put back if they do not load.
          </Dialog.Description>
          <div
            className="mt-4 grid max-h-[50vh] gap-4 overflow-y-auto"
            data-testid={`${testId}-files`}
          >
            {files.map((file) => (
              <section
                key={file.file}
                className="grid gap-1.5"
                aria-label={file.file}
                data-testid={`${testId}-file`}
                data-file={file.file}
              >
                <h3 className="m-0 font-mono text-[12px] font-medium text-kumo-default">
                  {file.file}
                </h3>
                <ul className="m-0 grid list-none gap-px overflow-hidden rounded-md p-0 ring ring-kumo-line">
                  {file.changes.map((change) => (
                    <li
                      key={change.key}
                      className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-baseline gap-3 bg-kumo-base px-3 py-1.5 font-mono text-[12px] odd:bg-kumo-elevated"
                      data-testid={`${testId}-change`}
                      data-key={change.key}
                    >
                      <span className="truncate text-kumo-default">{change.key}</span>
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        {change.secret ? (
                          <span className="text-kumo-subtle">{MASK}</span>
                        ) : change.before === null ? (
                          <span className="font-sans text-[12px] text-kumo-subtle">not set</span>
                        ) : (
                          <span className="break-all text-kumo-subtle line-through decoration-kumo-line">
                            {change.before === '' ? '""' : change.before}
                          </span>
                        )}
                        <ArrowRightIcon
                          size={11}
                          className="shrink-0 self-center text-kumo-subtle"
                          aria-label="becomes"
                        />
                        {change.after === null ? (
                          <span
                            className="font-sans text-[12px] text-kumo-subtle"
                            data-part="after"
                          >
                            removed
                          </span>
                        ) : (
                          <span className="break-all text-kumo-default" data-part="after">
                            {change.secret ? MASK : change.after === '' ? '""' : change.after}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="mt-4 mb-0 text-[14px] text-kumo-subtle">{note}</p>
          {error && (
            <div
              className="mt-3 grid gap-1 rounded-md bg-kumo-danger-tint px-3 py-2"
              role="alert"
              data-testid={`${testId}-error`}
            >
              <Text variant="error" size="sm">
                {error.message}
              </Text>
              {error.fix && (
                <span className="font-mono text-[12px] break-words text-kumo-default">
                  {error.fix}
                </span>
              )}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={pending}
              data-testid={`${testId}-cancel`}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onConfirm}
              loading={pending}
              data-testid={`${testId}-confirm`}
            >
              Save and reload
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
