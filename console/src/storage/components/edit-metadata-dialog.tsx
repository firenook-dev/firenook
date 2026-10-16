// Edit the metadata of many files at once (the selection bar's "Edit
// metadata…"): only the fields touched change — set one, clear one, set or
// remove custom keys — on every ticked file or everything a view matches,
// as one engine job judged file by file as the identity the page acts as.
// Setting `ownerUid` on fifty seeded images is one action, not fifty saves.

import { Button, Checkbox, Dialog, Input, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import type { StorageMetadataPatch } from '@/api/generated/storage/StorageMetadataPatch'
import { KeyValueEditor, type KeyValueRow } from '@/components/console/key-value-editor'
import { formatNumber } from '@/lib/format'
import { STANDARD_FIELDS, type StandardField, customKeyProblem } from '../metadata-draft'
import { MetadataField } from './metadata-field'

interface FieldEdit {
  value: string
  clear: boolean
}

const UNTOUCHED: Record<StandardField, FieldEdit> = {
  contentType: { value: '', clear: false },
  cacheControl: { value: '', clear: false },
  contentDisposition: { value: '', clear: false },
  contentEncoding: { value: '', clear: false },
  contentLanguage: { value: '', clear: false },
}

/** The patch a bulk edit sends: touched fields only, `null` to clear, keys set or removed. */
export function bulkPatch(
  fields: Record<StandardField, FieldEdit>,
  set: readonly KeyValueRow[],
  remove: string,
): StorageMetadataPatch {
  const patch: StorageMetadataPatch = {}
  for (const field of STANDARD_FIELDS) {
    const edit = fields[field]
    if (edit.clear) patch[field] = null
    else if (edit.value.trim() !== '') patch[field] = edit.value.trim()
  }
  const custom: Record<string, string | null> = {}
  for (const key of remove.split(/[,\s]+/).map((item) => item.trim()))
    if (key !== '') custom[key] = null
  for (const row of set) if (row.key.trim() !== '') custom[row.key.trim()] = row.value
  if (Object.keys(custom).length > 0) patch.customMetadata = custom
  return patch
}

export interface MetadataRequest {
  target: BulkTarget
  /** How many files it reaches. */
  objects: number
}

export function EditMetadataDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: MetadataRequest | undefined
  onCancel: () => void
  onConfirm: (patch: StorageMetadataPatch) => Promise<void>
}) {
  const [fields, setFields] = useState(UNTOUCHED)
  const [set, setSet] = useState<KeyValueRow[]>([])
  const [remove, setRemove] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const patch = bulkPatch(fields, set, remove)
  const touched = Object.keys(patch).length > 0
  const reset = () => {
    setFields(UNTOUCHED)
    setSet([])
    setRemove('')
    setError(undefined)
  }
  const count = request?.objects ?? 0
  const label = `${formatNumber(count)} ${count === 1 ? 'file' : 'files'}`
  return (
    <Dialog.Root
      open={request !== undefined}
      onOpenChange={(open) => {
        if (open) return
        reset()
        onCancel()
      }}
    >
      <Dialog size="lg" className="p-6 sm:w-[720px]">
        <div className="contents" data-testid="edit-metadata-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Edit metadata of {label}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            Only the fields you touch change; everything else is kept.
          </Dialog.Description>
          <div className="mt-4 grid gap-2">
            {STANDARD_FIELDS.map((field) => (
              <div key={field} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                {/* The row is the box's label, so the box is named by the field. */}
                <label className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-3">
                  <span className="font-mono text-[12px] text-kumo-subtle">{field}</span>
                  <MetadataField
                    field={field}
                    value={fields[field].value}
                    onChange={(value) =>
                      setFields((current) => ({ ...current, [field]: { value, clear: false } }))
                    }
                    placeholder={field === 'contentType' ? "— keep each file's —" : '— keep —'}
                  />
                </label>
                <Checkbox
                  checked={fields[field].clear}
                  onCheckedChange={(checked) =>
                    setFields((current) => ({
                      ...current,
                      [field]: { value: '', clear: Boolean(checked) },
                    }))
                  }
                  label="Clear"
                />
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-2">
            <KeyValueEditor
              label="Set custom keys"
              rows={set}
              onChange={setSet}
              validateKey={customKeyProblem}
              testId="bulk-set-keys"
            />
            <label className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-3">
              <span className="text-[13px] text-kumo-subtle">Remove custom keys</span>
              <Input
                size="sm"
                value={remove}
                onChange={(event) => setRemove(event.target.value)}
                placeholder="tmpTag, draft"
                spellCheck={false}
                autoComplete="off"
                className="w-full font-mono"
                data-testid="bulk-remove-keys"
              />
            </label>
          </div>
          <Text size="sm" variant="secondary" DANGEROUS_className="mt-4 block">
            Your onMetadataUpdated triggers run once per file ({formatNumber(count)}).
          </Text>
          {error && (
            <div className="mt-2">
              <Text variant="error" size="sm">
                {error}
              </Text>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                reset()
                onCancel()
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!touched || count === 0}
              loading={pending}
              onClick={async () => {
                setPending(true)
                setError(undefined)
                try {
                  await onConfirm(patch)
                  reset()
                } catch (thrown) {
                  setError(thrown instanceof Error ? thrown.message : String(thrown))
                } finally {
                  setPending(false)
                }
              }}
              data-testid="edit-metadata-confirm"
            >
              Edit {label}
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
