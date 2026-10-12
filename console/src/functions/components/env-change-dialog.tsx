// The one confirmation every change to a codebase's environment goes
// through — edit a variable, add one, set a declared param, add a missing
// secret: the values that change, per file, old → new (secrets masked),
// the files written, and that the codebase reloads. Save writes the files
// atomically and reloads; a reload that fails puts every file back, and the
// dialog says so with the load error, so a change that does not load never
// stays on disk.

import { Button, Dialog, Text } from '@cloudflare/kumo'
import { ArrowRightIcon, FloppyDiskIcon, XIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/api/client'
import type { FunctionEnvEditResult } from '@/api/generated/compute/FunctionEnvEditResult'
import type { FunctionEnvFile } from '@/api/generated/compute/FunctionEnvFile'
import { maskedText } from '@/components/console/masked-value'
import { toast } from '@/lib/toasts'
import { editEnv } from '../api'

/** One value that changes: in which file, from what to what (null: absent). */
export interface EnvChangeLine {
  file: FunctionEnvFile
  /** The file's name as the codebase has it: `.env`, `.env.demo-x`, `.secret.local`. */
  fileName: string
  key: string
  before: string | null
  after: string | null
  secret: boolean
}

/** The file a new value goes to, by name, for a project id. */
export function envFileName(file: FunctionEnvFile, project: string): string {
  switch (file) {
    case 'env':
      return '.env'
    case 'envProject':
      return `.env.${project}`
    case 'envAlias':
      return '.env.<alias>'
    case 'envLocal':
      return '.env.local'
    case 'secretLocal':
      return '.secret.local'
  }
}

/** The changes grouped by file, files in the order they first appear. */
export function byFile(lines: readonly EnvChangeLine[]): [string, EnvChangeLine[]][] {
  const groups = new Map<string, EnvChangeLine[]>()
  for (const line of lines) {
    const list = groups.get(line.fileName)
    if (list) list.push(line)
    else groups.set(line.fileName, [line])
  }
  return [...groups]
}

/** A secret's present value, which the console never held: shown as dots of no length. */
export const SECRET_KEPT = '\u0000kept'

function shown(line: EnvChangeLine, value: string | null): string {
  if (value === null) return 'not set'
  if (!line.secret) return value
  return maskedText(value === SECRET_KEPT ? undefined : value.length)
}

export function EnvChangeDialog({
  open,
  onOpenChange,
  codebase,
  lines,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  codebase: string
  lines: readonly EnvChangeLine[]
  onSaved?: ((result: FunctionEnvEditResult) => void) | undefined
}) {
  const [failure, setFailure] = useState<{ message: string; fix?: string | undefined } | null>(null)
  const save = useMutation({
    mutationFn: () =>
      editEnv(codebase, {
        changes: lines.map((line) => ({ file: line.file, key: line.key, value: line.after })),
      }),
    onSuccess: (result) => {
      setFailure(null)
      onOpenChange(false)
      onSaved?.(result)
      toast({
        key: `functions.env.${codebase}`,
        title: `Saved ${result.written.join(', ')}`,
        description: `${codebase} reloaded with the new values.`,
        tone: 'success',
      })
    },
    onError: (error) =>
      setFailure(
        error instanceof ApiError
          ? { message: error.message, fix: error.fix }
          : { message: 'The change could not be saved.' },
      ),
  })
  const close = (next: boolean) => {
    if (!next && save.isPending) return
    if (!next) setFailure(null)
    onOpenChange(next)
  }
  const groups = byFile(lines)
  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog className="p-6 sm:w-[720px]">
        <div className="contents" data-testid="env-change-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">
              {lines.length === 1
                ? 'Save this change and reload'
                : `Save ${lines.length} changes and reload`}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            {codebase} reloads with these values; calls in flight to its worker are dropped. If it
            does not load, your files are put back.
          </Dialog.Description>
          <div className="mt-4 grid gap-3" data-testid="env-change-files">
            {groups.map(([fileName, changes]) => (
              <div key={fileName} className="grid gap-1 rounded-lg p-3 ring ring-kumo-line">
                <span
                  className="font-mono text-[12px] text-kumo-subtle"
                  data-testid="env-change-file"
                >
                  {fileName}
                </span>
                {changes.map((line) => (
                  <div
                    key={line.key}
                    className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)_auto_minmax(0,1fr)] items-baseline gap-2 font-mono text-[12px]"
                    data-testid="env-change-line"
                  >
                    <span className="text-kumo-default">{line.key}</span>
                    <span
                      className={
                        line.before === null
                          ? 'truncate font-sans text-[13px] text-kumo-inactive'
                          : 'truncate text-kumo-subtle line-through decoration-kumo-hairline'
                      }
                    >
                      {shown(line, line.before)}
                    </span>
                    <ArrowRightIcon
                      size={12}
                      className="self-center text-kumo-subtle"
                      aria-hidden
                    />
                    <span
                      className={
                        line.after === null
                          ? 'truncate font-sans text-[13px] text-kumo-inactive'
                          : 'truncate text-kumo-default'
                      }
                    >
                      {line.after === null ? 'removed' : shown(line, line.after)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {failure && (
            <div
              className="mt-3 grid gap-1 rounded-lg bg-kumo-danger-tint px-3 py-2"
              data-testid="env-change-error"
            >
              <Text variant="error" size="sm">
                {failure.message}
              </Text>
              {failure.fix && (
                <pre className="max-h-40 overflow-auto font-mono text-[12px] whitespace-pre-wrap text-kumo-default">
                  {failure.fix}
                </pre>
              )}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => close(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<FloppyDiskIcon />}
              loading={save.isPending}
              onClick={() => save.mutate()}
              data-testid="env-change-save"
            >
              Save and reload
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
