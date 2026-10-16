// The open file, beside the list: the foundation's inspector (its width the
// person's, remembered under `storage.object`), with Details (preview, facts,
// where it lives, tokens), Metadata (one draft of the standard fields and the
// custom keys) and Activity (its changes, the decisions on its name, the
// event bodies it sends).
//
// The metadata draft and an edit of the text in place are the inspector's,
// so Save in the foot sends whichever changed — the text as one upload that
// keeps the metadata (and the draft's edits on top of it, so one write and
// one event), or the metadata alone as a patch guarded by the metageneration
// the draft was made from. When the file changes underneath (another tab,
// the app, a test), an unedited draft quietly follows it; an edited one gets
// the band — Load the new version, or Keep mine. A deleted file says who
// deleted it.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import { CornersOutIcon, FileXIcon, LockKeyIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { statusQuery } from '@/api/queries'
import { QueryError } from '@/components/console/empty-state'
import { Inspector, InspectorFooter, InspectorTitle } from '@/components/console/inspector'
import { SectionBanner } from '@/components/console/section-banner'
import { describeViewAsShort, identityKey } from '@/lib/identity'
import { formatBytes, relativeTime } from '@/lib/format'
import { useNow } from '@/lib/clock'
import { useShortcuts } from '@/lib/shortcuts'
import { toast } from '@/lib/toasts'
import { StorageApiError, updateMetadata, uploadObject } from '../../api'
import { storageAddress } from '../../code'
import { useFiles } from '../../files-state'
import {
  type MetadataDraft,
  changeCount,
  draftOf,
  draftProblems,
  patchOf,
  uploadMetadataOf,
} from '../../metadata-draft'
import { storagePool } from '../../net'
import { baseName, parentOf } from '../../paths'
import { activityQuery, asIdentity, objectQuery, profileQuery, storageKeys } from '../../queries'
import { RefusalDetail } from '../refusal-detail'
import { ActivityTab } from './activity-tab'
import { FileCodePopover } from './code-popover'
import { DetailsTab } from './details-tab'
import { MetadataTab } from './metadata-tab'

/** Where the inspector's width is remembered. */
export const INSPECTOR_WIDTH_KEY = 'storage.object'

interface Drafts {
  /** The object the drafts were made from. */
  base: StorageObjectDetail
  baseDraft: MetadataDraft
  draft: MetadataDraft
  /** The text being edited in place; `undefined` while reading. */
  text: string | undefined
  /** A save met a newer metageneration: the band asks what to do. */
  conflict: boolean
}

function fresh(object: StorageObjectDetail): Drafts {
  const draft = draftOf(object)
  return { base: object, baseDraft: draft, draft, text: undefined, conflict: false }
}

/** The same object, unchanged: same generation and metageneration. */
function same(a: StorageObjectDetail, b: StorageObjectDetail): boolean {
  return a.generation === b.generation && a.metageneration === b.metageneration
}

export function FileInspector({
  name,
  onPrev,
  onNext,
  onQuickLook,
  tools,
  danger,
}: {
  name: string
  onPrev?: (() => void) | undefined
  onNext?: (() => void) | undefined
  onQuickLook: () => void
  /** More tools for the foot (download, move, duplicate). */
  tools?: ((object: StorageObjectDetail) => ReactNode) | undefined
  /** The foot's destructive control (delete). */
  danger?: ((object: StorageObjectDetail) => ReactNode) | undefined
}) {
  const files = useFiles()
  const queryClient = useQueryClient()
  const status = useQuery(statusQuery)
  const address = storageAddress(status.data)
  const query = useQuery(objectQuery(files.project, files.bucket, name, files.viewAs))
  const profile = useQuery(profileQuery(files.project, files.bucket, parentOf(name)))
  const object = query.data
  const [drafts, setDrafts] = useState<Drafts | undefined>(object ? fresh(object) : undefined)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<StorageApiError | Error | undefined>(undefined)

  // The drafts follow the object: a new file starts them again; an
  // unedited draft follows a newer version; an edited one keeps its base
  // and the band says the file changed.
  let current = drafts
  if (
    object &&
    (!current || current.base.name !== object.name || current.base.bucket !== object.bucket)
  ) {
    current = fresh(object)
    setDrafts(current)
    setSaveError(undefined)
  }
  const patch = current ? patchOf(current.baseDraft, current.draft) : {}
  const changes = changeCount(patch) + (current?.text !== undefined ? 1 : 0)
  const dirty = changes > 0
  if (object && current && !same(object, current.base) && !dirty) {
    current = fresh(object)
    setDrafts(current)
  }
  const underneath = Boolean(object && current && !same(object, current.base) && dirty)
  const problems = current ? draftProblems(current.draft) : new Map<string, string>()

  const update = (next: Partial<Drafts>) =>
    setDrafts((before) => (before ? { ...before, ...next } : before))

  const keep = (saved: StorageObjectDetail) => {
    queryClient.setQueryData(
      storageKeys.object(files.project, files.bucket, saved.name, identityKey(files.viewAs)),
      saved,
    )
    setDrafts(fresh(saved))
  }

  const save = async () => {
    if (!current || !dirty || problems.size > 0 || saving) return
    setSaving(true)
    setSaveError(undefined)
    try {
      if (current.text !== undefined) {
        const metadata = uploadMetadataOf(current.draft)
        const release = await storagePool.acquire('upload')
        try {
          const saved = await asIdentity(files.viewAs, files.project, (authorization) =>
            uploadObject(current.text ?? '', {
              bucket: current.base.bucket,
              name: current.base.name,
              contentType: metadata.contentType,
              metadata: {
                cacheControl: metadata.cacheControl,
                contentDisposition: metadata.contentDisposition,
                contentEncoding: metadata.contentEncoding,
                contentLanguage: metadata.contentLanguage,
                customMetadata: metadata.customMetadata,
              },
              keepTokens: files.admin,
              authorization,
            }),
          )
          keep(saved)
        } finally {
          release()
        }
        toast({
          key: 'storage-save',
          title: `Saved ${baseName(name)}`,
          description: 'A new generation; your onObjectFinalized triggers run.',
          tone: 'success',
        })
      } else {
        const saved = await asIdentity(files.viewAs, files.project, (authorization) =>
          updateMetadata(
            {
              bucket: current.base.bucket,
              name: current.base.name,
              metadata: patch,
              ifMetagenerationMatch: current.base.metageneration,
            },
            { authorization },
          ),
        )
        keep(saved)
        toast({
          key: 'storage-save',
          title: `Saved the metadata of ${baseName(name)}`,
          tone: 'success',
        })
      }
    } catch (error) {
      if (error instanceof StorageApiError && error.code === 'failed-precondition') {
        update({ conflict: true })
        void query.refetch()
      } else setSaveError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      setSaving(false)
    }
  }

  useShortcuts({ id: 'storage-inspector', label: 'File' }, [
    {
      key: 'Mod+s',
      label: 'Save the file',
      allowInInputs: true,
      when: () => dirty,
      run: () => void save(),
    },
  ])

  const band =
    (underneath || current?.conflict) && object ? (
      <SectionBanner
        tone="warning"
        testId="changed-underneath"
        action={
          <span className="flex gap-1">
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setDrafts(fresh(object))}
              data-testid="load-new-version"
            >
              Load the new version
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => update({ base: object, conflict: false })}
              data-testid="keep-mine"
            >
              Keep mine
            </Button>
          </span>
        }
      >
        Changed since you opened it.
      </SectionBanner>
    ) : null

  const size = object ? formatBytes(object.size) : undefined
  return (
    <Inspector
      widthKey={INSPECTOR_WIDTH_KEY}
      title={<InspectorTitle value={name}>{baseName(name) || name}</InspectorTitle>}
      meta={object ? <Meta size={size ?? ''} updated={object.updated} /> : undefined}
      actions={
        <Tooltip
          content="Quick Look (Shift+Space)"
          render={
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CornersOutIcon />}
              aria-label="Quick Look"
              onClick={onQuickLook}
              data-testid="inspector-quick-look"
            />
          }
        />
      }
      onClose={() => files.openObject(undefined)}
      closeLabel="Close the file"
      tabs={{
        items: [
          { value: 'details', label: 'Details' },
          {
            value: 'metadata',
            label: 'Metadata',
            count: object ? Object.keys(object.customMetadata).length || undefined : undefined,
          },
          { value: 'activity', label: 'Activity' },
        ],
        value: files.tab,
        onChange: (tab) =>
          files.update(
            { tab: tab === 'details' ? undefined : (tab as 'metadata' | 'activity') },
            { replace: true },
          ),
      }}
      onPrev={onPrev}
      onNext={onNext}
      noun="file"
      footer={
        object && current ? (
          <InspectorFooter
            testId="inspector-footer"
            tools={
              <>
                <FileCodePopover object={object} defaultBucket={files.buckets.defaultBucket} />
                {tools?.(object)}
              </>
            }
            danger={danger?.(object)}
            primary={
              <>
                {dirty && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setDrafts({
                        ...current,
                        draft: current.baseDraft,
                        text: undefined,
                        conflict: false,
                      })
                    }
                    data-testid="inspector-revert"
                  >
                    Revert
                  </Button>
                )}
                <Tooltip
                  content={
                    current.text !== undefined
                      ? 'Writes the text as a new generation with the metadata; your onObjectFinalized triggers run.'
                      : dirty
                        ? 'Saves the metadata; your onMetadataUpdated triggers run.'
                        : 'Nothing has changed yet.'
                  }
                  render={
                    <span className="inline-flex">
                      <Button
                        variant={dirty ? 'primary' : 'secondary'}
                        size="sm"
                        disabled={!dirty || problems.size > 0}
                        loading={saving}
                        onClick={() => void save()}
                        data-testid="inspector-save"
                      >
                        {dirty ? `Save ${changes}` : 'Save'}
                      </Button>
                    </span>
                  }
                />
              </>
            }
          />
        ) : undefined
      }
      testId="file-inspector"
    >
      {query.isPending ? (
        <div className="grid gap-2 px-5 py-4" aria-busy>
          <div className="h-40 animate-pulse rounded-md bg-kumo-tint" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-kumo-tint" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-kumo-tint" />
        </div>
      ) : query.isError ? (
        <Unreadable error={query.error} name={name} onRetry={() => void query.refetch()} />
      ) : object && current ? (
        <>
          {saveError && (
            <SectionBanner
              tone="danger"
              testId="save-error"
              action={
                saveError instanceof StorageApiError && saveError.refused ? (
                  <RefusalDetail
                    extras={saveError.extras}
                    trigger={
                      <Button variant="secondary" size="xs">
                        See why
                      </Button>
                    }
                  />
                ) : undefined
              }
              onDismiss={() => setSaveError(undefined)}
            >
              {saveError.message}
            </SectionBanner>
          )}
          {files.tab === 'metadata' ? (
            <MetadataTab
              object={object}
              base={current.baseDraft}
              draft={current.draft}
              onChange={(draft) => update({ draft })}
              band={band}
              keySuggestions={profile.data?.metadataKeys ?? []}
            />
          ) : files.tab === 'activity' ? (
            <ActivityTab object={object} />
          ) : (
            <>
              {current.text !== undefined && band}
              <DetailsTab
                object={object}
                project={files.project}
                address={address}
                edit={{ draft: current.text, onDraft: (text) => update({ text }) }}
                onQuickLook={onQuickLook}
                onFixType={async (contentType) => {
                  try {
                    const saved = await asIdentity(files.viewAs, files.project, (authorization) =>
                      updateMetadata(
                        { bucket: object.bucket, name: object.name, metadata: { contentType } },
                        { authorization },
                      ),
                    )
                    keep(saved)
                    toast({
                      key: 'storage-save',
                      title: `contentType is ${contentType}`,
                      tone: 'success',
                    })
                  } catch (error) {
                    setSaveError(error instanceof Error ? error : new Error(String(error)))
                  }
                }}
              />
            </>
          )}
        </>
      ) : null}
    </Inspector>
  )
}

function Meta({ size, updated }: { size: string; updated: string }) {
  const now = useNow('minute')
  return (
    <>
      <span className="font-mono">{size}</span>
      <span>·</span>
      <span>{relativeTime(updated, now)}</span>
    </>
  )
}

/** The object cannot be shown: deleted, refused to this identity, or the engine said no. */
function Unreadable({ error, name, onRetry }: { error: Error; name: string; onRetry: () => void }) {
  const files = useFiles()
  const deleted = error instanceof StorageApiError && error.code === 'not-found'
  const activity = useQuery({
    ...activityQuery(files.project, files.bucket, name),
    enabled: deleted,
  })
  const now = useNow('second')
  if (error instanceof StorageApiError && error.refused)
    return (
      <div className="grid justify-items-start gap-2 px-5 py-5" data-testid="read-refused">
        <LockKeyIcon size={28} className="text-kumo-inactive" />
        <Text>
          {describeViewAsShort(files.viewAs)} can't read this file.{' '}
          {error.extras.line
            ? `Line ${error.extras.line} refused it.`
            : 'No allow matched, so the rules refused it.'}
        </Text>
        <RefusalDetail
          extras={error.extras}
          trigger={
            <Button variant="secondary" size="sm">
              See why
            </Button>
          }
        />
      </div>
    )
  if (deleted) {
    const gone = activity.data?.changes.find((change) => change.kind === 'deleted')
    const who = gone
      ? (gone.actor.uid ??
        (gone.actor.kind === 'admin' || gone.actor.kind === 'system'
          ? 'Admin'
          : 'an anonymous client'))
      : undefined
    return (
      <div className="grid justify-items-start gap-2 px-5 py-5" data-testid="object-deleted">
        <FileXIcon size={28} className="text-kumo-inactive" />
        <Text>
          {gone
            ? `Deleted by ${who} ${relativeTime(gone.at, now)}${gone.actor.viaConsole ? ' from the console' : ''}.`
            : 'This file no longer exists.'}
        </Text>
      </div>
    )
  }
  return <QueryError error={error} onRetry={onRetry} section="storage" />
}
