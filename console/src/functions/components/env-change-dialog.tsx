// The one confirmation every change to a codebase's environment goes
// through — set a declared param, add a missing secret: the values that
// change, per file, old → new (secrets masked),
// and that the codebase reloads. It is the dialog Extensions' configuration
// uses (`src/compute/env-change-dialog.tsx`), so a save says the same thing
// wherever it is made. Save writes the files atomically and reloads; a
// reload that fails puts every file back, and the dialog says so with the
// load error, so a change that does not load never stays on disk.

import { useMutation } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import type { FunctionEnvEditResult } from '@/api/generated/compute/FunctionEnvEditResult'
import type { FunctionEnvFile } from '@/api/generated/compute/FunctionEnvFile'
import { EnvChangeDialog as ChangeDialog, type EnvFileChange } from '@/compute/env-change-dialog'
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

/** The lines as the shared dialog lists them: per file, under the codebase's directory. */
export function changedFiles(
  lines: readonly EnvChangeLine[],
  directory: string | undefined,
): EnvFileChange[] {
  return byFile(lines).map(([fileName, changes]) => ({
    file: directory ? `${directory}/${fileName}` : fileName,
    changes: changes.map((line) => ({
      key: line.key,
      before: line.before,
      after: line.after,
      secret: line.secret,
    })),
  }))
}

export function EnvChangeDialog({
  open,
  onOpenChange,
  codebase,
  directory,
  lines,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  codebase: string
  /** The codebase's source directory, relative to the project (`functions`). */
  directory?: string | undefined
  lines: readonly EnvChangeLine[]
  onSaved?: ((result: FunctionEnvEditResult) => void) | undefined
}) {
  const save = useMutation({
    mutationFn: () =>
      editEnv(codebase, {
        changes: lines.map((line) => ({ file: line.file, key: line.key, value: line.after })),
      }),
    onSuccess: (result) => {
      onOpenChange(false)
      onSaved?.(result)
      toast({
        key: `functions.env.${codebase}`,
        title: `Saved ${result.written.join(', ')}`,
        description: `${codebase} reloaded with the new values.`,
        tone: 'success',
      })
    },
  })
  const error = save.error
    ? save.error instanceof ApiError
      ? { message: save.error.message, fix: save.error.fix }
      : { message: 'The change could not be saved.' }
    : undefined
  return (
    <ChangeDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) save.reset()
        onOpenChange(next)
      }}
      title={
        lines.length === 1
          ? 'Save this change and reload'
          : `Save ${lines.length} changes and reload`
      }
      files={changedFiles(lines, directory)}
      note={`${codebase} reloads with these values; calls in flight to its worker are dropped.`}
      pending={save.isPending}
      error={error}
      onConfirm={() => save.mutate()}
    />
  )
}
