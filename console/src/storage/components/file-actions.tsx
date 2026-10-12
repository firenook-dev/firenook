// What the Files page does to objects beyond reading them: download (a
// file, a folder or a selection as a streamed zip), rename in place, move,
// copy, duplicate, edit the metadata of many, delete, and empty a bucket.
// One file deleted is one request; anything more is one engine job, whose
// counts the confirmation shows first (the verb's dry run) and whose
// progress, failures and Cancel come from the job. Every destructive step
// goes through the foundation's DangerConfirm, with the functions it would
// run when the engine knows them.

import { Button, DropdownMenu } from '@cloudflare/kumo'
import {
  ArrowsOutCardinalIcon,
  CloudArrowUpIcon,
  CopyIcon,
  DownloadSimpleIcon,
  SlidersHorizontalIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import type { StorageBulkPreview } from '@/api/generated/storage/StorageBulkPreview'
import type { StorageConflictPolicy } from '@/api/generated/storage/StorageConflictPolicy'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { useInspectorRoom } from '@/components/console/inspector'
import { download } from '@/lib/download'
import { formatBytes, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { useTriggersFor } from '@/lib/triggers'
import {
  type StorageBulkVerb,
  deleteObject,
  exportTicket,
  exportUrl,
  mediaUrl,
  previewBulk,
  startBulk,
} from '../api'
import type { EntryActions } from '../entry-menu'
import { useFiles } from '../files-state'
import { baseName, parentOf } from '../paths'
import { asIdentity, storageKeys } from '../queries'
import { selectionTarget, useFileSelection } from '../selection'
import { existingNames, keepBothName } from '../uploads'
import { EditMetadataDialog, type MetadataRequest } from './edit-metadata-dialog'
import { MoveDialog, type MoveRequest } from './move-dialog'
import { UploadsInProgress, useSessions } from './uploads-in-progress'

type Confirm =
  | { kind: 'file'; name: string; size: number }
  | {
      kind: 'bulk'
      target: BulkTarget
      title: string
      resource: string
      preview: StorageBulkPreview | undefined
    }
  | { kind: 'empty'; preview: StorageBulkPreview | undefined }
  | {
      kind: 'replace'
      verb: 'move' | 'copy'
      target: BulkTarget
      destination: { bucket: string; prefix: string }
      preview: StorageBulkPreview
    }

const keyOf = (entry: StorageEntry) => (entry.type === 'folder' ? entry.prefix : entry.name)

/** "900 files · 20 MB in 121 folders": what a preview says will be touched. */
export function previewSentence(preview: StorageBulkPreview): string {
  const files = `${formatNumber(preview.objects)} ${preview.objects === 1 ? 'file' : 'files'} · ${formatBytes(preview.bytes)}`
  return preview.folders > 0
    ? `${files} in ${formatNumber(preview.folders)} ${preview.folders === 1 ? 'folder' : 'folders'}`
    : files
}

/** A toast for an action that did not go through. */
function fail(title: string, thrown: unknown): void {
  toast({
    key: 'storage-action',
    title,
    description: thrown instanceof Error ? thrown.message : String(thrown),
    tone: 'danger',
  })
}

/** An object as a row, for the inspector's tools. */
function entryOf(object: StorageObjectDetail): StorageEntry {
  return {
    type: 'file',
    name: object.name,
    size: object.size,
    contentType: object.contentType,
    contentEncoding: object.contentEncoding,
    updated: object.updated,
    timeCreated: object.timeCreated,
    generation: object.generation,
    tokens: object.downloadTokens.length,
    metadataKeys: Object.keys(object.customMetadata),
    metadataCount: Object.keys(object.customMetadata).length,
  }
}

export interface FileActions {
  entryActions: Partial<EntryActions>
  selectionActions: ReactNode
  bucketMenu: ReactNode
  inspectorTools: (object: StorageObjectDetail) => ReactNode
  inspectorDanger: (object: StorageObjectDetail) => ReactNode
  /** The row being renamed in place. */
  renaming: string | undefined
  startRename: (entry: StorageEntry) => void
  commitRename: (entry: StorageEntry, name: string) => void
  cancelRename: () => void
  /** Delete the ticked rows (⌫). */
  deleteTicked: () => void
  /** Copy an object of this project here (a pasted gs:// URL). */
  copyHere: (bucket: string, name: string) => void
  /** Opens "Uploads in progress" beside an element. */
  showSessions: (anchor: Element | null) => void
  /** Resumable uploads the bucket holds. */
  unfinished: number
  element: ReactNode
}

export function useFileActions(selectionScope: {
  prefix: string
  flat: boolean
  q: string | undefined
}): FileActions {
  const files = useFiles()
  const queryClient = useQueryClient()
  const [confirm, setConfirm] = useState<Confirm | undefined>(undefined)
  const [jobId, setJobId] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [move, setMove] = useState<MoveRequest | undefined>(undefined)
  const [metadata, setMetadata] = useState<MetadataRequest | undefined>(undefined)
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const checked = useFileSelection((state) => state.checked)
  const everything = useFileSelection((state) => state.everything)
  const clearSelection = useFileSelection((state) => state.clear)
  const sessions = useSessions()
  const [sessionsAnchor, setSessionsAnchor] = useState<Element | null>(null)

  const resource =
    confirm?.kind === 'file'
      ? `${files.bucket}|${confirm.name}`
      : confirm?.kind === 'bulk'
        ? `${files.bucket}|${confirm.resource}`
        : confirm?.kind === 'empty'
          ? `${files.bucket}|`
          : undefined
  const triggers = useTriggersFor('storage', resource)

  const as = <T,>(send: (authorization: string | undefined) => Promise<T>) =>
    asIdentity(files.viewAs, files.project, send)

  const selected = (): BulkTarget =>
    selectionTarget(checked, everything, {
      bucket: files.bucket,
      prefix: selectionScope.prefix,
      flat: selectionScope.flat,
      q: selectionScope.q,
    })

  /** Starts a verb as a job and keeps its id for the confirmation's progress. */
  const run = async (verb: StorageBulkVerb, body: Parameters<typeof startBulk>[1]) => {
    const job = await as((authorization) => startBulk(verb, body, { authorization }))
    return job
  }

  // ---- Delete -------------------------------------------------------------

  const askDelete = (target: BulkTarget, title: string, where: string) => {
    setConfirm({ kind: 'bulk', target, title, resource: where, preview: undefined })
    setError(undefined)
    setJobId(undefined)
    void as((authorization) =>
      previewBulk(
        'delete',
        { bucket: files.bucket, target, onConflict: 'skip' },
        { authorization },
      ),
    )
      .then((preview) =>
        setConfirm((current) => (current?.kind === 'bulk' ? { ...current, preview } : current)),
      )
      .catch((thrown: unknown) =>
        setError(thrown instanceof Error ? thrown.message : String(thrown)),
      )
  }

  const deleteEntry = (entry: StorageEntry) => {
    if (entry.type === 'file') {
      setConfirm({ kind: 'file', name: entry.name, size: entry.size })
      setError(undefined)
      setJobId(undefined)
      return
    }
    askDelete(
      { by: 'keys', keys: [entry.prefix] },
      `Delete ${baseName(entry.prefix) || '(empty)'}/`,
      entry.prefix,
    )
  }

  const deleteTicked = () => {
    if (checked.size === 0 && !everything) return
    const keys = [...checked]
    const only = keys.length === 1 ? keys[0] : undefined
    if (!everything && only !== undefined && !only.endsWith('/')) {
      setConfirm({ kind: 'file', name: only, size: 0 })
      setError(undefined)
      setJobId(undefined)
      return
    }
    if (!everything && only !== undefined && only.endsWith('/')) {
      askDelete({ by: 'keys', keys: [only] }, `Delete ${baseName(only) || '(empty)'}/`, only)
      return
    }
    askDelete(
      selected(),
      everything
        ? `Delete everything ${files.q.trim() ? 'matching' : 'here'}`
        : `Delete ${formatNumber(keys.length)} ${keys.length === 1 ? 'item' : 'items'}`,
      selectionScope.prefix,
    )
  }

  const confirmDelete = async () => {
    if (!confirm) return
    setPending(true)
    setError(undefined)
    try {
      if (confirm.kind === 'file') {
        await as((authorization) =>
          deleteObject({ bucket: files.bucket, name: confirm.name }, { authorization }),
        )
        if (files.object === confirm.name) files.openObject(undefined)
        clearSelection()
        toast({
          key: 'storage-action',
          title: `Deleted ${baseName(confirm.name)}`,
          tone: 'success',
        })
        setConfirm(undefined)
        return
      }
      if (confirm.kind === 'replace') {
        const job = await run(confirm.verb, {
          bucket: files.bucket,
          target: confirm.target,
          destination: confirm.destination,
          onConflict: 'replace',
        })
        setJobId(job.id)
        clearSelection()
        return
      }
      const target: BulkTarget =
        confirm.kind === 'empty'
          ? { by: 'query', q: '', scope: { bucket: files.bucket, prefix: '', flat: true } }
          : confirm.target
      const job = await run('delete', { bucket: files.bucket, target, onConflict: 'skip' })
      setJobId(job.id)
      clearSelection()
      if (files.object !== undefined) files.openObject(undefined)
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setPending(false)
    }
  }

  // ---- Move, copy, duplicate, rename ---------------------------------------

  const askMove = (verb: 'move' | 'copy', target: BulkTarget, what: string, objects?: number) => {
    setMove({ verb, target, what, objects })
    if (objects === undefined)
      void as((authorization) =>
        previewBulk(
          verb,
          {
            bucket: files.bucket,
            target,
            destination: { bucket: files.bucket, prefix: '' },
            onConflict: 'skip',
          },
          { authorization },
        ),
      )
        .then((preview) =>
          setMove((current) =>
            current?.target === target ? { ...current, objects: preview.objects } : current,
          ),
        )
        .catch(() => {
          // The count is only the title's; the move itself says what it did.
        })
  }

  const confirmMove = async (
    destination: { bucket: string; prefix: string },
    policy: StorageConflictPolicy,
  ) => {
    if (!move) return
    const body = { bucket: files.bucket, target: move.target, destination, onConflict: policy }
    if (policy === 'replace') {
      const preview = await as((authorization) => previewBulk(move.verb, body, { authorization }))
      if (preview.conflicts > 0) {
        setMove(undefined)
        setJobId(undefined)
        setError(undefined)
        setConfirm({ kind: 'replace', verb: move.verb, target: move.target, destination, preview })
        return
      }
    }
    await run(move.verb, body)
    clearSelection()
    setMove(undefined)
  }

  const duplicate = async (entry: StorageEntry) => {
    if (entry.type !== 'file') return
    try {
      const candidates: string[] = []
      const taken = new Set<string>([entry.name])
      for (let index = 0; index < 20; index += 1) {
        const next = keepBothName(entry.name, taken)
        candidates.push(next)
        taken.add(next)
      }
      const existing = await existingNames(files.bucket, candidates)
      const name = candidates.find((candidate) => !existing.has(candidate))
      if (!name) throw new Error('Twenty copies of this file are here already; rename one first.')
      await run('copy', {
        bucket: files.bucket,
        target: { by: 'keys', keys: [entry.name] },
        renameTo: name,
        onConflict: 'fail',
      })
      toast({
        key: 'storage-action',
        title: `Duplicating ${baseName(entry.name)} as ${baseName(name)}`,
        tone: 'success',
      })
    } catch (thrown) {
      fail('Could not duplicate the file', thrown)
    }
  }

  const commitRename = (entry: StorageEntry, typed: string) => {
    setRenaming(undefined)
    const name = typed.trim()
    const from = keyOf(entry)
    const folder = entry.type === 'folder'
    const parent = parentOf(folder ? from.slice(0, -1) : from)
    if (name === '' || name.includes('/')) {
      if (name.includes('/'))
        toast({
          key: 'storage-action',
          title: 'A name cannot contain /; use Move to change its folder.',
          tone: 'warning',
        })
      return
    }
    const to = `${parent}${name}${folder ? '/' : ''}`
    if (to === from) return
    void run('move', {
      bucket: files.bucket,
      target: { by: 'keys', keys: [from] },
      renameTo: to,
      onConflict: 'fail',
    })
      .then(() => {
        // The open object follows its new name.
        if (files.object === from) files.openObject(to, { replace: true })
        toast({ key: 'storage-action', title: `Renamed to ${baseName(to)}`, tone: 'success' })
      })
      .catch((thrown: unknown) => fail('Could not rename', thrown))
  }

  // ---- Downloads -----------------------------------------------------------

  const downloadEntry = (entry: StorageEntry) => {
    if (entry.type === 'file')
      void download(
        mediaUrl({
          bucket: files.bucket,
          name: entry.name,
          generation: entry.generation,
          download: true,
        }),
        baseName(entry.name),
      )
    else
      void download(
        exportUrl(files.bucket, entry.prefix),
        `${baseName(entry.prefix) || files.bucket}.zip`,
      )
  }

  const downloadSelection = async () => {
    const keys = [...checked]
    const only = keys[0]
    if (!everything && keys.length === 1 && only !== undefined && !only.endsWith('/')) {
      void download(mediaUrl({ bucket: files.bucket, name: only, download: true }), baseName(only))
      return
    }
    try {
      const ticket = await exportTicket({ bucket: files.bucket, target: selected() })
      void download(ticket.url)
    } catch (thrown) {
      fail('Could not start the download', thrown)
    }
  }

  // ---- Metadata ------------------------------------------------------------

  const askMetadata = (target: BulkTarget, known?: number) => {
    if (known !== undefined) {
      setMetadata({ target, objects: known })
      return
    }
    void as((authorization) =>
      previewBulk(
        'metadata',
        { bucket: files.bucket, target, metadata: {}, onConflict: 'skip' },
        { authorization },
      ),
    )
      .then((preview) => setMetadata({ target, objects: preview.objects }))
      .catch((thrown: unknown) => fail('Could not count the files', thrown))
  }

  const copyHere = (bucket: string, name: string) => {
    if (bucket !== files.bucket) {
      toast({
        key: 'storage-action',
        title: 'Copies stay within a bucket here; open that bucket and use Copy… there.',
        tone: 'warning',
      })
      return
    }
    void run('copy', {
      bucket: files.bucket,
      target: { by: 'keys', keys: [name] },
      destination: { bucket: files.bucket, prefix: files.prefix },
      onConflict: 'fail',
    })
      .then(() =>
        toast({ key: 'storage-action', title: `Copying ${baseName(name)} here`, tone: 'success' }),
      )
      .catch((thrown: unknown) => fail(`Could not copy ${baseName(name)} here`, thrown))
  }

  const selectionCount = everything ? undefined : checked.size
  const what =
    selectionCount === undefined
      ? 'everything selected'
      : `${formatNumber(selectionCount)} ${selectionCount === 1 ? 'item' : 'items'}`

  const entryActions: Partial<EntryActions> = {
    download: downloadEntry,
    rename: (entry) => setRenaming(keyOf(entry)),
    move: (entry) =>
      askMove(
        'move',
        { by: 'keys', keys: [keyOf(entry)] },
        keyOf(entry),
        entry.type === 'file' ? 1 : undefined,
      ),
    copyTo: (entry) => askMove('copy', { by: 'keys', keys: [keyOf(entry)] }, keyOf(entry)),
    duplicate: (entry) => void duplicate(entry),
    editMetadata: (entry) =>
      askMetadata({ by: 'keys', keys: [keyOf(entry)] }, entry.type === 'file' ? 1 : undefined),
    delete: deleteEntry,
  }

  const selectionActions = (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<DownloadSimpleIcon />}
        onClick={() => void downloadSelection()}
        title="Downloads as Admin"
        data-testid="selection-download"
      >
        Download
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon={<SlidersHorizontalIcon />}
        onClick={() => askMetadata(selected())}
        data-testid="selection-metadata"
      >
        Edit metadata…
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon={<ArrowsOutCardinalIcon />}
        onClick={() => askMove('move', selected(), what, selectionCount)}
        data-testid="selection-move"
      >
        Move…
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon={<CopyIcon />}
        onClick={() => askMove('copy', selected(), what, selectionCount)}
        data-testid="selection-copy"
      >
        Copy…
      </Button>
      <span className="mx-1 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
      <Button
        variant="ghost"
        size="sm"
        icon={<TrashIcon className="text-kumo-danger" />}
        onClick={deleteTicked}
        data-testid="selection-delete"
      >
        <span className="text-kumo-danger">
          Delete{selectionCount === undefined ? ' all' : ` ${formatNumber(selectionCount)}`}
        </span>
      </Button>
    </>
  )

  const unfinished = sessions.data?.items.length ?? 0
  const bucketMenu = (
    <>
      <DropdownMenu.Item
        icon={DownloadSimpleIcon}
        onClick={() => void download(exportUrl(files.bucket), `${files.bucket}.zip`)}
        data-testid="bucket-download"
      >
        Download the bucket as .zip
      </DropdownMenu.Item>
      <DropdownMenu.Item
        icon={CloudArrowUpIcon}
        onClick={() => setSessionsAnchor(document.querySelector('[data-testid="bucket-menu"]'))}
        data-testid="bucket-sessions"
      >
        Uploads in progress{unfinished > 0 ? ` · ${formatNumber(unfinished)}` : ''}
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item
        icon={TrashIcon}
        variant="danger"
        onClick={() => {
          setError(undefined)
          setJobId(undefined)
          setConfirm({ kind: 'empty', preview: undefined })
          void as((authorization) =>
            previewBulk(
              'delete',
              {
                bucket: files.bucket,
                target: {
                  by: 'query',
                  q: '',
                  scope: { bucket: files.bucket, prefix: '', flat: true },
                },
                onConflict: 'skip',
              },
              { authorization },
            ),
          )
            .then((preview) =>
              setConfirm((current) =>
                current?.kind === 'empty' ? { ...current, preview } : current,
              ),
            )
            .catch((thrown: unknown) =>
              setError(thrown instanceof Error ? thrown.message : String(thrown)),
            )
        }}
        data-testid="bucket-empty"
      >
        Empty the bucket…
      </DropdownMenu.Item>
    </>
  )

  const confirmTitle =
    confirm?.kind === 'file'
      ? `Delete ${baseName(confirm.name)}`
      : confirm?.kind === 'bulk'
        ? confirm.title
        : confirm?.kind === 'empty'
          ? 'Empty the bucket'
          : confirm?.kind === 'replace'
            ? `Replace ${formatNumber(confirm.preview.conflicts)} ${confirm.preview.conflicts === 1 ? 'file' : 'files'}`
            : ''
  const preview =
    confirm?.kind === 'bulk' || confirm?.kind === 'empty' ? confirm.preview : undefined
  const description =
    confirm?.kind === 'file'
      ? `${confirm.name}${confirm.size > 0 ? ` (${formatBytes(confirm.size)})` : ''} is removed from the emulator.`
      : confirm?.kind === 'replace'
        ? `In ${confirm.destination.prefix || `gs://${confirm.destination.bucket}`}, these names are taken and are replaced: ${confirm.preview.conflictSample.slice(0, 6).map(baseName).join(', ')}${confirm.preview.conflicts > 6 ? `, +${formatNumber(confirm.preview.conflicts - 6)}` : ''}.`
        : !preview
          ? 'Counting what this removes…'
          : confirm?.kind === 'empty'
            ? `Every object in gs://${files.bucket} — ${previewSentence(preview)} — is removed from the emulator.`
            : confirm?.kind === 'bulk' &&
                confirm.resource.endsWith('/') &&
                confirm.target.by === 'keys' &&
                confirm.target.keys.length === 1
              ? `${confirm.resource} and everything under it — ${previewSentence(preview)} — ${preview.objects === 1 ? 'is' : 'are'} removed from the emulator.`
              : `${previewSentence(preview)} ${preview.objects === 1 ? 'is' : 'are'} removed from the emulator.`
  const times = confirm?.kind === 'file' ? 1 : (preview?.objects ?? 0)

  const element = (
    <>
      <DangerConfirm
        open={confirm !== undefined}
        onOpenChange={(open) => {
          if (open) return
          setConfirm(undefined)
          setJobId(undefined)
          setError(undefined)
        }}
        title={confirmTitle}
        description={description}
        {...(triggers !== 'unknown' && triggers !== 'absent' && confirm?.kind !== 'replace'
          ? { triggers: { answer: triggers, times } }
          : {})}
        consequences={
          confirm?.kind === 'replace'
            ? [
                'The files there now are overwritten; their old bytes and tokens are gone.',
                'Functions see an upload for each replaced file.',
              ]
            : ['Re-seed or re-import to get them back.']
        }
        {...(confirm?.kind === 'empty' ? { confirmText: files.bucket } : {})}
        {...(jobId ? { jobId } : {})}
        progressVerb={
          confirm?.kind === 'replace' ? (confirm.verb === 'move' ? 'moved' : 'copied') : 'deleted'
        }
        {...(error ? { error } : {})}
        pending={
          pending ||
          ((confirm?.kind === 'bulk' || confirm?.kind === 'empty') &&
            preview === undefined &&
            !error)
        }
        onConfirm={() => void confirmDelete()}
        testId="storage-danger"
      />
      <UploadsInProgress anchor={sessionsAnchor} onClose={() => setSessionsAnchor(null)} />
      <MoveDialog request={move} onCancel={() => setMove(undefined)} onConfirm={confirmMove} />
      <EditMetadataDialog
        request={metadata}
        onCancel={() => setMetadata(undefined)}
        onConfirm={async (patch) => {
          if (!metadata) return
          await run('metadata', {
            bucket: files.bucket,
            target: metadata.target,
            metadata: patch,
            onConflict: 'skip',
          })
          void queryClient.invalidateQueries({
            queryKey: storageKeys.objectAnyone(files.project, files.bucket, files.object ?? ''),
          })
          setMetadata(undefined)
          clearSelection()
        }}
      />
    </>
  )

  return {
    entryActions,
    selectionActions,
    bucketMenu,
    inspectorTools: (object) => <InspectorTools actions={entryActions} entry={entryOf(object)} />,
    inspectorDanger: (object) => (
      <Button
        variant="ghost"
        size="sm"
        icon={<TrashIcon className="text-kumo-danger" />}
        onClick={() => deleteEntry(entryOf(object))}
        data-testid="inspector-delete"
      >
        <span className="text-kumo-danger">Delete</span>
      </Button>
    ),
    renaming,
    startRename: (entry) => setRenaming(keyOf(entry)),
    commitRename,
    cancelRename: () => setRenaming(undefined),
    deleteTicked,
    copyHere,
    showSessions: setSessionsAnchor,
    unfinished,
    element,
  }
}

/** The inspector foot's tools: Download, Move, Duplicate (labels go first when the panel is narrow). */
function InspectorTools({
  entry,
  actions,
}: {
  entry: StorageEntry
  actions: Partial<EntryActions>
}) {
  const room = useInspectorRoom()
  const tool = (label: string, icon: ReactNode, run: (() => void) | undefined, testId: string) =>
    room.labels ? (
      <Button variant="ghost" size="sm" icon={icon} onClick={run} data-testid={testId}>
        {label}
      </Button>
    ) : (
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        icon={icon}
        aria-label={label}
        onClick={run}
        data-testid={testId}
      />
    )
  return (
    <>
      {tool(
        'Download',
        <DownloadSimpleIcon />,
        () => actions.download?.(entry),
        'inspector-download',
      )}
      {tool('Move', <ArrowsOutCardinalIcon />, () => actions.move?.(entry), 'inspector-move')}
      {tool('Duplicate', <CopyIcon />, () => actions.duplicate?.(entry), 'inspector-duplicate')}
    </>
  )
}
