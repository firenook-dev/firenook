// "Open a bucket by name…": a bucket exists for the emulator once something
// is written to it, so one the engine does not list yet can still be
// browsed, written to from here, and given rules on the Rules page. In
// per-bucket mode a bucket firebase.json does not name has no rules, and the
// dialog says what that means before it opens.

import { Button, Dialog, Input, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { StorageRulesMode } from '@/api/generated/storage/StorageRulesMode'

/** Why a typed bucket name cannot be a GCS bucket, or `undefined` when it can. */
export function bucketNameProblem(name: string): string | undefined {
  if (name === '') return undefined
  if (name.length < 3 || name.length > 222) return 'A bucket name is 3 to 222 characters long.'
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(name))
    return 'Use lowercase letters, digits, dots, dashes and underscores, starting and ending with a letter or digit.'
  return undefined
}

export function OpenBucketDialog({
  open,
  onOpenChange,
  known,
  rulesMode,
  onOpenBucket,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The buckets the engine lists, which open from the picker itself. */
  known: readonly string[]
  rulesMode: StorageRulesMode | null
  onOpenBucket: (bucket: string) => void
}) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const problem = bucketNameProblem(trimmed)
  const unlisted = trimmed !== '' && !known.includes(trimmed)
  const close = (next: boolean) => {
    if (!next) setName('')
    onOpenChange(next)
  }
  const submit = () => {
    if (trimmed === '' || problem) return
    onOpenBucket(trimmed)
    close(false)
  }
  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog size="base" className="p-6 sm:w-[448px]">
        <div className="contents" data-testid="open-bucket-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Open a bucket by name</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            A bucket exists in the emulator once something is written to it, so you can open one
            that holds nothing yet.
          </Dialog.Description>
          <form
            className="mt-4 grid gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <Input
              size="sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-project-uploads"
              aria-label="Bucket name"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              className="w-full font-mono"
              data-testid="open-bucket-name"
            />
            {problem ? (
              <Text variant="error" size="sm">
                {problem}
              </Text>
            ) : unlisted && rulesMode === 'perBucket' ? (
              <Text variant="secondary" size="sm">
                firebase.json gives no rules to{' '}
                <span className="font-mono text-[0.9em]">{trimmed}</span>, so the emulator refuses
                every client request to it, the Admin SDK included. The console can still browse and
                write to it.
              </Text>
            ) : null}
          </form>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={trimmed === '' || problem !== undefined}
              data-testid="open-bucket-confirm"
            >
              Open
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
