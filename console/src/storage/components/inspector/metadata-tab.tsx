// The object's metadata as one draft: the standard fields as free text with
// suggestions (`MetadataField`, the box every place metadata is typed uses)
// and the custom keys as rows with the add line always there. A changed
// field carries the unsaved mark; Save in the inspector's foot sends the
// smallest patch, guarded by the metageneration the draft was made from.

import { Tooltip } from '@cloudflare/kumo'
import { CheckIcon, InfoIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { InspectorSection } from '@/components/console/inspector'
import { KeyValueEditor } from '@/components/console/key-value-editor'
import { essence } from '../../mime'
import {
  type MetadataDraft,
  type StandardField,
  changedFields,
  customKeyProblem,
  patchOf,
} from '../../metadata-draft'
import { MetadataField } from '../metadata-field'

/** One field row: the name, the unsaved mark, the box, and what follows it. */
function FieldRow({
  name,
  changed,
  children,
  after,
  testId,
}: {
  name: string
  changed: boolean
  children: ReactNode
  after?: ReactNode
  testId: string
}) {
  return (
    // The row is the box's label, so the name it shows is the name it has.
    <label
      className="grid min-h-7 grid-cols-[9.5rem_minmax(0,1fr)_auto] items-center gap-2"
      data-testid={testId}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-kumo-subtle">
        <span className="truncate">{name}</span>
        {changed && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-kumo-brand"
            aria-label="Unsaved"
            data-testid="unsaved-mark"
          />
        )}
      </span>
      <span className="min-w-0">{children}</span>
      <span className="flex min-w-4 items-center">{after}</span>
    </label>
  )
}

export function MetadataTab({
  object,
  base,
  draft,
  onChange,
  band,
  keySuggestions,
}: {
  object: StorageObjectDetail
  /** The draft of the object as it was opened. */
  base: MetadataDraft
  draft: MetadataDraft
  onChange: (draft: MetadataDraft) => void
  /** "Changed since you opened it", when it was. */
  band?: ReactNode
  /** Custom keys other files in the folder carry. */
  keySuggestions: readonly string[]
}) {
  const changed = changedFields(patchOf(base, draft))
  const set = (field: StandardField, value: string) =>
    onChange({ ...draft, fields: { ...draft.fields, [field]: value } })
  const detected =
    object.sniffed?.definite && essence(draft.fields.contentType) === object.sniffed.mime
  return (
    <div data-testid="metadata-tab">
      {band}
      <InspectorSection title="Standard" testId="metadata-standard">
        <div className="grid gap-1.5">
          <FieldRow
            name="contentType"
            changed={changed.has('contentType')}
            testId="field-contentType"
            after={
              detected ? (
                <Tooltip
                  content="The bytes say the same"
                  render={
                    <CheckIcon size={13} className="text-kumo-success" aria-label="Detected" />
                  }
                />
              ) : null
            }
          >
            <MetadataField
              field="contentType"
              value={draft.fields.contentType}
              onChange={(value) => set('contentType', value)}
              placeholder="application/octet-stream"
              object={object}
            />
          </FieldRow>
          <FieldRow
            name="cacheControl"
            changed={changed.has('cacheControl')}
            testId="field-cacheControl"
          >
            <MetadataField
              field="cacheControl"
              value={draft.fields.cacheControl}
              onChange={(value) => set('cacheControl', value)}
              object={object}
            />
          </FieldRow>
          <FieldRow
            name="contentDisposition"
            changed={changed.has('contentDisposition')}
            testId="field-contentDisposition"
          >
            <MetadataField
              field="contentDisposition"
              value={draft.fields.contentDisposition}
              onChange={(value) => set('contentDisposition', value)}
              object={object}
            />
          </FieldRow>
          <FieldRow
            name="contentEncoding"
            changed={changed.has('contentEncoding')}
            testId="field-contentEncoding"
            after={
              <Tooltip
                content="Says how the stored bytes are encoded; changing it does not re-encode them."
                render={
                  <InfoIcon
                    size={13}
                    className="text-kumo-subtle"
                    aria-label="About contentEncoding"
                  />
                }
              />
            }
          >
            <MetadataField
              field="contentEncoding"
              value={draft.fields.contentEncoding}
              onChange={(value) => set('contentEncoding', value)}
              object={object}
            />
          </FieldRow>
          <FieldRow
            name="contentLanguage"
            changed={changed.has('contentLanguage')}
            testId="field-contentLanguage"
          >
            <MetadataField
              field="contentLanguage"
              value={draft.fields.contentLanguage}
              onChange={(value) => set('contentLanguage', value)}
              placeholder="en"
            />
          </FieldRow>
        </div>
      </InspectorSection>
      {/* The editor names its own list ("Custom metadata · 2"), with its
          rows and the add line under them. */}
      <section
        className="shrink-0 border-t border-kumo-line px-5 py-2"
        aria-label="Custom metadata"
        data-testid="metadata-custom"
      >
        <KeyValueEditor
          label="Custom metadata"
          rows={draft.custom}
          onChange={(rows) => onChange({ ...draft, custom: rows })}
          suggestKeys={keySuggestions}
          validateKey={customKeyProblem}
          testId="custom-metadata"
        />
      </section>
    </div>
  )
}
