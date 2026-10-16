// Row one's path field, the Firestore path bar's twin: the scope picker
// leads in a fixed place, then the field — `gs://<bucket>` and each folder
// as a segment to go back to, the last one not faded — with copy inside it
// against its right edge. Clicking the field, or ⌘L, makes it an input
// without changing its geometry: type a folder (completed from the engine,
// Tab takes the first), an object ("Go to file"), or paste any Storage URL —
// gs://, a download URL from an app or production, a JSON API URL — and it
// lands there, the file open. An empty segment (`a//`) is the italic
// `(empty)` and is never collapsed, so every name GCS allows is reachable.

import { Button, Tooltip } from '@cloudflare/kumo'
import { FileIcon, FolderIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import { CopyGlyph, useCopied } from '@/components/kit'
import { OWNER_AUTHORIZATION } from '@/lib/identity'
import { quoteFilterText } from '@/lib/filter'
import { useShortcuts } from '@/lib/shortcuts'
import { listObjects, objectsExist } from '../api'
import { useFiles } from '../files-state'
import {
  type StorageLocation,
  baseName,
  gsUrl,
  normalizeFolder,
  parentOf,
  parseLocation,
  segments,
} from '../paths'
import { useDebounced } from '@/rules/use-debounced'
import { ST } from '../queries'
import { bucketPatch } from '../search'
import { ScopePicker } from './scope-picker'

/** Completions the field offers at most. */
const SUGGESTIONS = 12

/**
 * A path too long for its box scrolls to its end, where you are; the box
 * and the segments in it both change size, so both are watched for as long
 * as the box is on screen (a callback ref: it attaches with the box).
 */
function followEnd(box: HTMLDivElement | null) {
  if (!box) return undefined
  const toEnd = () => {
    box.scrollLeft = box.scrollWidth
  }
  toEnd()
  const observer = new ResizeObserver(toEnd)
  observer.observe(box)
  if (box.firstElementChild) observer.observe(box.firstElementChild)
  return () => observer.disconnect()
}

export function StoragePathBar() {
  const files = useFiles()
  const [editing, setEditing] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { copied, copy } = useCopied()
  const knownBuckets = files.buckets.buckets.map((bucket) => bucket.name)

  useShortcuts({ id: 'storage-path', label: 'Storage' }, [
    {
      key: 'Mod+l',
      label: 'Edit the path',
      run: () => setEditing(gsUrl(files.bucket, files.prefix)),
    },
  ])

  const typed = editing ?? ''
  const context = { buckets: knownBuckets, bucket: files.bucket }
  const target = editing === null ? undefined : parseLocation(typed, context)
  const parent = target ? parentOf(target.path) : ''
  const partial = target ? target.path.slice(parent.length) : ''
  // The engine is asked once typing settles, not for every key.
  const settled = useDebounced(typed, 120)
  const debounced = editing === null ? undefined : parseLocation(settled, context)
  const completions = useQuery({
    queryKey: [
      ST,
      files.project,
      debounced?.bucket ?? '',
      'path-completions',
      debounced?.path ?? '',
    ],
    queryFn: async ({ signal }) => {
      const at = debounced as StorageLocation
      const folder = parentOf(at.path)
      const word = at.path.slice(folder.length)
      const [page, exists] = await Promise.all([
        listObjects(
          {
            bucket: at.bucket,
            prefix: folder,
            kind: 'folders',
            q: word ? quoteFilterText(word) : undefined,
          },
          { limit: 100 },
          // Completion is navigation: it reads as the operator, as the tree does.
          { authorization: OWNER_AUTHORIZATION, signal },
        ),
        word && !word.endsWith('/')
          ? objectsExist({ bucket: at.bucket, names: [at.path] }, signal)
          : Promise.resolve({ existing: [] }),
      ])
      return { folders: page.items, file: exists.existing[0] }
    },
    enabled: editing !== null && debounced !== undefined,
    staleTime: 5_000,
    retry: false,
  })
  const folders = (completions.data?.folders ?? [])
    .filter((entry): entry is Extract<StorageEntry, { type: 'folder' }> => entry.type === 'folder')
    .filter((entry) =>
      entry.prefix.slice(parent.length).toLowerCase().startsWith(partial.toLowerCase()),
    )
    .slice(0, SUGGESTIONS)
  const file = completions.data?.file
  const fresh = debounced?.bucket === target?.bucket && debounced?.path === target?.path

  /** Opens a location: another bucket, a folder, or the file with its folder around it. */
  const go = async (location: StorageLocation) => {
    setEditing(null)
    const patch =
      location.bucket === files.bucket
        ? {}
        : bucketPatch(location.bucket === files.buckets.defaultBucket ? undefined : location.bucket)
    if (location.path === '' || location.path.endsWith('/')) {
      files.update({ ...patch, path: location.path || undefined, object: undefined, q: undefined })
      return
    }
    let isFile = file === location.path && fresh
    if (!isFile) {
      try {
        const answer = await objectsExist({ bucket: location.bucket, names: [location.path] })
        isFile = answer.existing.includes(location.path)
      } catch {
        isFile = false
      }
    }
    if (isFile)
      files.update({
        ...patch,
        path: parentOf(location.path) || undefined,
        object: location.path,
        q: undefined,
      })
    else
      files.update({
        ...patch,
        path: normalizeFolder(location.path),
        object: undefined,
        q: undefined,
      })
  }

  const steps = segments(files.prefix)
  const showList = editing !== null && fresh && (folders.length > 0 || file !== undefined)

  return (
    <div
      // The clip keeps the never-shrinking controls from painting over the
      // status group; it lifts while completions can hang below the row, and
      // reaches a step past its contents so no frame or focus ring is cut.
      className={`-mx-1 flex h-full min-w-0 flex-1 items-center gap-1 px-1 ${
        editing === null ? 'overflow-hidden' : ''
      }`}
      data-testid="path-bar"
    >
      <div className="flex shrink-0 items-center" data-testid="path-controls">
        <ScopePicker />
        <span className="mr-0.5 ml-1.5 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
      </div>
      <div
        className={`group relative flex h-8 min-w-0 flex-1 items-center rounded-lg pr-0.5 pl-1 ${
          editing === null ? 'hover:ink' : 'bg-kumo-control ring ring-kumo-focus'
        }`}
        data-testid="path-field"
      >
        {editing === null ? (
          <>
            <div
              ref={followEnd}
              className="flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              data-testid="path-segments"
            >
              <div className="flex items-center">
                <Segment
                  label={`gs://${files.bucket}`}
                  current={steps.length === 0}
                  onClick={() => files.goTo('')}
                  first
                />
                {steps.map((step, index) => (
                  <Segment
                    key={step.prefix}
                    label={step.label}
                    current={index === steps.length - 1}
                    onClick={() => files.goTo(step.prefix)}
                  />
                ))}
              </div>
            </div>
            <button
              type="button"
              className="h-7 flex-1 basis-0 cursor-text rounded-md px-1.5 text-left text-[12px] text-kumo-inactive"
              onClick={() => setEditing(gsUrl(files.bucket, files.prefix))}
              aria-label="Edit the path"
            />
          </>
        ) : (
          <input
            ref={inputRef}
            // Starts with the whole path selected, so typing replaces it.
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            onPaste={(event) => {
              // A pasted URL lands where it points at once.
              const text = event.clipboardData.getData('text')
              if (!/^(gs:\/\/|https?:\/\/)/i.test(text.trim())) return
              const location = parseLocation(text, { buckets: knownBuckets, bucket: files.bucket })
              if (!location) return
              event.preventDefault()
              void go(location)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (target) void go(target)
                else setEditing(null)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(null)
              } else if (event.key === 'Tab' && folders[0]) {
                event.preventDefault()
                setEditing(gsUrl(target?.bucket ?? files.bucket, folders[0].prefix))
              }
            }}
            onBlur={() =>
              window.setTimeout(
                () => setEditing((current) => (current === editing ? null : current)),
                120,
              )
            }
            className="h-full min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[12px] text-kumo-default outline-none"
            placeholder="gs://bucket/folder/ or a download URL"
            spellCheck={false}
            autoComplete="off"
            aria-label="Path"
            data-testid="path-input"
          />
        )}
        <Tooltip
          content={
            copied
              ? 'Copied'
              : files.object
                ? 'Copy the file’s gs:// URL'
                : 'Copy the folder’s gs:// URL'
          }
          render={
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CopyGlyph copied={copied} />}
              aria-label="Copy the gs:// URL"
              className="h-7 w-7 shrink-0"
              onClick={() => void copy(gsUrl(files.bucket, files.object ?? files.prefix))}
              data-testid="copy-path"
            />
          }
        />
        <span className="sr-only" aria-live="polite">
          {copied ? 'Copied' : ''}
        </span>
        {showList && (
          <ul
            className="absolute top-full left-0 z-20 mt-1 max-h-64 w-max min-w-80 max-w-[40rem] overflow-auto rounded-lg bg-kumo-elevated p-1 shadow-md ring ring-kumo-line"
            data-testid="path-completions"
          >
            {file !== undefined && (
              <li>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:ink"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void go({ bucket: target?.bucket ?? files.bucket, path: file })}
                  data-testid="path-go-file"
                >
                  <FileIcon size={14} className="shrink-0 text-kumo-subtle" />
                  <span className="min-w-0 flex-1 truncate">
                    Go to file <span className="font-mono text-[0.9em]">{baseName(file)}</span>
                  </span>
                </button>
              </li>
            )}
            {folders.map((folder) => (
              <li key={folder.prefix}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[12px] hover:ink"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    void go({ bucket: target?.bucket ?? files.bucket, path: folder.prefix })
                  }
                  data-testid="path-completion"
                >
                  <FolderIcon size={14} className="shrink-0 text-kumo-subtle" />
                  {folder.prefix}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Segment({
  label,
  onClick,
  current,
  first,
}: {
  label: string
  onClick: () => void
  current?: boolean
  first?: boolean
}) {
  return (
    <span className="flex shrink-0 items-center">
      {!first && <span className="px-0.5 text-[12px] text-kumo-inactive">/</span>}
      <button
        type="button"
        onClick={onClick}
        className={`flex h-7 items-center rounded-md px-1.5 font-mono text-[12px] hover:ink hover:text-kumo-default ${
          current ? 'text-kumo-default' : 'text-kumo-subtle'
        }`}
        aria-current={current ? 'location' : undefined}
        data-testid="path-segment"
      >
        {label === '' ? <span className="font-sans italic">(empty)</span> : label}
      </button>
    </span>
  )
}
