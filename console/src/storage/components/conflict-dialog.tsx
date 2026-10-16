// One question for a whole drop whose names are partly taken: replace them,
// skip them, or keep both (`name (1).png`) — with the drop's options one
// click away, and, while Functions runs, that uploads fire the triggers.
// Replacing turns the button red and says how many.

import { Button, Dialog, Radio, Text } from '@cloudflare/kumo'
import { UploadSimpleIcon, XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { formatNumber } from '@/lib/format'
import type { UploadOptions } from '../upload-options'
import type { ConflictChoice } from '../uploads'
import { UploadOptionsFields } from './upload-options-fields'

export interface ConflictStep {
  /** Files in the drop. */
  total: number
  /** The names already taken, in the drop's order. */
  conflicts: readonly string[]
  /** Where the drop lands, for the sentence. */
  folder: string
  options: UploadOptions
  /** Opened on purpose ("Upload with options…"), not only for conflicts. */
  withOptions: boolean
}

/** `3 files`, `1 file`. */
function files(count: number): string {
  return `${formatNumber(count)} ${count === 1 ? 'file' : 'files'}`
}

/** "12 of 340 files already exist", "1 file already exists", "Upload 3 files". */
export function conflictTitle(conflicts: number, total: number): string {
  if (conflicts === 0) return `Upload ${files(total)}`
  const verb = conflicts === 1 ? 'exists' : 'exist'
  return conflicts === total
    ? `${files(conflicts)} already ${verb}`
    : `${formatNumber(conflicts)} of ${files(total)} already ${verb}`
}

export function ConflictDialog({
  step,
  functions,
  onCancel,
  onConfirm,
}: {
  step: ConflictStep | undefined
  /** Functions runs in the suite: uploads fire its Storage triggers. */
  functions: boolean
  onCancel: () => void
  onConfirm: (choice: ConflictChoice, options: UploadOptions) => void
}) {
  const [choice, setChoice] = useState<ConflictChoice>('skip')
  const [options, setOptions] = useState<UploadOptions | undefined>(undefined)
  const shown = options ?? step?.options
  const conflicts = step?.conflicts.length ?? 0
  const sending = step ? (choice === 'skip' ? step.total - conflicts : step.total) : 0
  const close = () => {
    setOptions(undefined)
    setChoice('skip')
    onCancel()
  }
  return (
    <Dialog.Root open={step !== undefined} onOpenChange={(open) => !open && close()}>
      <Dialog size="base" className="p-6 sm:w-[448px]">
        <div className="contents" data-testid="conflict-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">
              {conflictTitle(conflicts, step?.total ?? 0)}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            Into <span className="font-mono text-[0.9em]">{step?.folder}</span>
            {conflicts > 0 && (
              <>
                {': '}
                <span className="font-mono text-[0.9em]">
                  {step?.conflicts
                    .slice(0, 3)
                    .map((name) => name.slice(name.lastIndexOf('/') + 1))
                    .join(', ')}
                </span>
                {conflicts > 3 ? `, +${formatNumber(conflicts - 3)}` : ''}
              </>
            )}
          </Dialog.Description>
          {conflicts > 0 && (
            <Radio.Group
              legend="When a name is taken"
              value={choice}
              onValueChange={(value) => setChoice(value as ConflictChoice)}
              className="mt-4"
            >
              <Radio.Item label="Replace them" value="replace" />
              <Radio.Item label="Skip them" value="skip" />
              <Radio.Item label="Keep both (name (1).png)" value="keep" />
            </Radio.Group>
          )}
          <div className="mt-4">
            {shown && (
              <UploadOptionsFields
                options={shown}
                onChange={setOptions}
                defaultOpen={step?.withOptions ?? false}
              />
            )}
          </div>
          {functions && (
            <Text size="sm" variant="secondary" DANGEROUS_className="mt-3 block">
              Uploads fire your Storage triggers.
            </Text>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant={choice === 'replace' && conflicts > 0 ? 'destructive' : 'primary'}
              icon={<UploadSimpleIcon />}
              disabled={sending === 0}
              onClick={() => {
                if (!step || !shown) return
                onConfirm(choice, shown)
                setOptions(undefined)
                setChoice('skip')
              }}
              data-testid="conflict-confirm"
            >
              {sending === 0
                ? 'Nothing to upload'
                : choice === 'replace' && conflicts > 0
                  ? `Replace ${formatNumber(conflicts)} · Upload ${formatNumber(sending)}`
                  : `Upload ${formatNumber(sending)}`}
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
