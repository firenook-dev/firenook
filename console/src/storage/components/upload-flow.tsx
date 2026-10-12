// How files get from a drop, a picker or a paste into the upload queue:
// operating-system litter left out, the names checked against the bucket
// (a thousand at a time), and — when some are taken, or the options were
// asked for — one question for the whole drop. A drop with nothing taken
// starts at once with the bucket's remembered options.

import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { type DroppedFile, withoutSystemFiles } from '../drop'
import { useFiles } from '../files-state'
import {
  type UploadOptions,
  metadataOf,
  readOptions,
  typeFor,
  writeOptions,
} from '../upload-options'
import {
  type ConflictChoice,
  type UploadPlan,
  enqueueUploads,
  existingNames,
  resolveConflicts,
} from '../uploads'
import { type ConflictStep, ConflictDialog } from './conflict-dialog'

interface Pending {
  step: ConflictStep
  files: DroppedFile[]
  prefix: string
  existing: Set<string>
}

export interface UploadFlow {
  /** Uploads files into `prefix`, asking only when names are taken. */
  start: (files: readonly DroppedFile[], prefix: string) => Promise<void>
  /** Uploads with chosen options (the upload dialog), asking only when names are taken. */
  startWith: (
    files: readonly DroppedFile[],
    prefix: string,
    options: UploadOptions,
  ) => Promise<void>
  /** The conflict question, to render once on the page. */
  element: ReactNode
}

function plansOf(
  files: readonly DroppedFile[],
  prefix: string,
  options: UploadOptions,
): UploadPlan[] {
  const metadata = metadataOf(options)
  return files.map((entry) => ({
    file: entry.file,
    name: `${prefix}${entry.path}`,
    size: entry.file.size,
    contentType: typeFor(entry.file, options),
    metadata,
  }))
}

export function useUploadFlow(): UploadFlow {
  const files = useFiles()
  const status = useQuery(statusQuery)
  const functions =
    status.data?.sections.find((entry) => entry.id === 'functions')?.state === 'ready'
  const [pending, setPending] = useState<Pending | undefined>(undefined)
  const context = { bucket: files.bucket, project: files.project, viewAs: files.viewAs }

  const prepare = async (
    dropped: readonly DroppedFile[],
    prefix: string,
    options: UploadOptions,
    withOptions: boolean,
  ) => {
    const { files: kept, skipped } = withoutSystemFiles(dropped)
    if (skipped.length > 0)
      toast({
        key: 'storage-system-files',
        title: `${formatNumber(skipped.length)} system ${skipped.length === 1 ? 'file' : 'files'} skipped`,
        description: skipped.slice(0, 3).join(', '),
      })
    if (kept.length === 0) return
    let existing: Set<string>
    try {
      existing = await existingNames(
        files.bucket,
        kept.map((entry) => `${prefix}${entry.path}`),
      )
    } catch (error) {
      toast({
        key: 'storage-upload-check',
        title: 'Could not check which names are taken',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
      return
    }
    if (existing.size > 0 || withOptions) {
      setPending({
        files: kept,
        prefix,
        existing,
        step: {
          total: kept.length,
          conflicts: kept
            .map((entry) => `${prefix}${entry.path}`)
            .filter((name) => existing.has(name)),
          folder: prefix === '' ? `gs://${files.bucket}` : prefix,
          options,
          withOptions,
        },
      })
      return
    }
    await enqueueUploads(plansOf(kept, prefix, options), context)
  }

  const confirm = (choice: ConflictChoice, options: UploadOptions) => {
    if (!pending) return
    writeOptions(files.project, files.bucket, options)
    const { send, skipped } = resolveConflicts(
      plansOf(pending.files, pending.prefix, options),
      pending.existing,
      choice,
    )
    setPending(undefined)
    void enqueueUploads(send, context, skipped)
  }

  return {
    start: (dropped, prefix) =>
      prepare(dropped, prefix, readOptions(files.project, files.bucket), false),
    startWith: (dropped, prefix, options) => {
      writeOptions(files.project, files.bucket, options)
      return prepare(dropped, prefix, options, false)
    },
    element: (
      <ConflictDialog
        step={pending?.step}
        functions={functions}
        onCancel={() => setPending(undefined)}
        onConfirm={confirm}
      />
    ),
  }
}
