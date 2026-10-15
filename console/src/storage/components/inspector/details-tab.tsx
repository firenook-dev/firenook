// What a file is: its preview (collapsible, remembered), a warning when its
// content type surely disagrees with its bytes (with the one-click fix), the
// facts the engine keeps, where it lives — gs://, the path an SDK takes, the
// download URL an app connected to the emulator gets, the REST metadata URL —
// and its download tokens.

import { Button, Text } from '@cloudflare/kumo'
import { CaretRightIcon, WarningIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { InspectorSection } from '@/components/console/inspector'
import { KeyValueList } from '@/components/console/key-value-list'
import { exactTime } from '@/components/console/relative-time'
import { formatNumber, utcStamp } from '@/lib/format'
import { contentTypeMismatch, describeSignature, withArticle } from '../../content'
import { downloadUrl } from '../../code'
import { encodeObjectPath, gsUrl } from '../../paths'
import { Preview } from './preview'
import type { TextEdit } from './preview-text'
import { Tokens } from './tokens'

const PREVIEW_OPEN = 'firenook.console.storage-preview-open'

function readOpen(): boolean {
  try {
    return localStorage.getItem(PREVIEW_OPEN) !== 'false'
  } catch {
    return true
  }
}

export function DetailsTab({
  object,
  project,
  address,
  edit,
  onQuickLook,
  onFixType,
}: {
  object: StorageObjectDetail
  project: string
  address: string | undefined
  edit?: TextEdit | undefined
  onQuickLook: () => void
  /** Sets contentType to what the bytes are. */
  onFixType: (contentType: string) => Promise<void>
}) {
  const [open, setOpen] = useState(readOpen)
  const [fixing, setFixing] = useState(false)
  const mismatch = contentTypeMismatch(object)
  const token = object.downloadTokens[0]
  const facts = [
    { label: 'name', value: object.name, copy: object.name, testId: 'fact-name' },
    { label: 'bucket', value: object.bucket, copy: object.bucket },
    {
      label: 'size',
      value: `${formatNumber(object.size)} bytes`,
      copy: String(object.size),
      testId: 'fact-size',
    },
    { label: 'type', value: object.contentType ?? '—', copy: object.contentType ?? undefined },
    ...(object.contentEncoding
      ? [{ label: 'encoding', value: object.contentEncoding, copy: object.contentEncoding }]
      : []),
    {
      label: 'created',
      value: utcStamp(object.timeCreated),
      hint: exactTime(object.timeCreated),
      copy: object.timeCreated,
    },
    {
      label: 'updated',
      value: utcStamp(object.updated),
      hint: exactTime(object.updated),
      copy: object.updated,
    },
    { label: 'generation', value: object.generation, copy: object.generation },
    { label: 'metageneration', value: object.metageneration, copy: object.metageneration },
    { label: 'md5', value: object.md5Hash, copy: object.md5Hash },
    { label: 'crc32c', value: object.crc32c, copy: object.crc32c },
    { label: 'etag', value: object.etag, copy: object.etag },
    { label: 'storage class', value: object.storageClass },
  ]
  const location = [
    {
      label: 'gs://',
      value: gsUrl(object.bucket, object.name),
      copy: gsUrl(object.bucket, object.name),
      testId: 'location-gs',
    },
    { label: 'path', value: object.name, copy: object.name, testId: 'location-path' },
    ...(address && token
      ? [
          {
            label: 'download URL',
            value: (
              <span className="grid gap-0.5">
                <span className="truncate">
                  {downloadUrl(address, object.bucket, object.name, token)}
                </span>
                <span className="font-sans text-[11px] text-kumo-subtle">
                  For an app connected to {address}
                </span>
              </span>
            ),
            copy: downloadUrl(address, object.bucket, object.name, token),
            testId: 'location-download',
          },
        ]
      : []),
    ...(address
      ? [
          {
            label: 'REST',
            value: `http://${address}/v0/b/${encodeURIComponent(object.bucket)}/o/${encodeObjectPath(object.name)}`,
            copy: `http://${address}/v0/b/${encodeURIComponent(object.bucket)}/o/${encodeObjectPath(object.name)}`,
          },
        ]
      : []),
  ]
  return (
    <>
      <section
        className="shrink-0 px-5 pt-2 pb-3"
        aria-label="Preview"
        data-testid="preview-section"
      >
        <button
          type="button"
          className="-ml-1 flex h-6 items-center gap-1 rounded-md px-1 text-[12px] text-kumo-subtle hover:ink hover:text-kumo-default"
          aria-expanded={open}
          onClick={() => {
            const next = !open
            setOpen(next)
            try {
              localStorage.setItem(PREVIEW_OPEN, String(next))
            } catch {
              // Remembered for this page only.
            }
          }}
          data-testid="preview-toggle"
        >
          <CaretRightIcon size={11} weight="bold" className={open ? 'rotate-90' : ''} />
          Preview
        </button>
        {open && (
          <div className="mt-1.5">
            <Preview object={object} project={project} edit={edit} onQuickLook={onQuickLook} />
          </div>
        )}
      </section>
      {mismatch && (
        <div
          className="mx-5 mb-3 flex shrink-0 items-start gap-2 rounded-md bg-kumo-warning-tint px-3 py-2 ring ring-kumo-line"
          data-testid="type-mismatch"
        >
          <WarningIcon size={14} className="mt-0.5 shrink-0 text-kumo-warning" />
          <div className="grid min-w-0 gap-1.5">
            <Text size="sm">
              Looks like {withArticle(describeSignature(mismatch))}, but contentType says{' '}
              <span className="font-mono text-[0.9em]">{object.contentType ?? 'nothing'}</span>, so
              browsers download it instead of showing it.
            </Text>
            <span>
              <Button
                variant="secondary"
                size="xs"
                loading={fixing}
                onClick={async () => {
                  setFixing(true)
                  try {
                    await onFixType(mismatch)
                  } finally {
                    setFixing(false)
                  }
                }}
                data-testid="type-mismatch-fix"
              >
                Set contentType to {mismatch}
              </Button>
            </span>
          </div>
        </div>
      )}
      <InspectorSection title="Facts" testId="facts">
        <KeyValueList items={facts} testId="facts-list" />
      </InspectorSection>
      <InspectorSection title="Location" testId="location">
        <KeyValueList items={location} testId="location-list" />
      </InspectorSection>
      <Tokens object={object} project={project} />
    </>
  )
}
