// The bucket as a tree in the section panel, set like Firestore's schema
// tree: the bucket at the root, folders under it, each with the files under
// it, open only along the path to where you are. A node's folders are read
// when it opens (the first 100 by name; past them the last row offers the
// rest in the list), and every figure is the folder index's, kept current
// by the live channel — a write anywhere below moves the counts of every
// folder above it.

import { FolderIcon, FolderSimpleDashedIcon, HardDrivesIcon } from '@phosphor-icons/react'
import { useQueries } from '@tanstack/react-query'
import { useState } from 'react'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import type { StorageFolderEntry } from '@/api/generated/storage/StorageFolderEntry'
import type { StorageListPage } from '@/api/generated/storage/StorageListPage'
import { type PanelTreeNode, PanelTree } from '@/components/console/panel-tree'
import { formatBytes, formatNumber, relativeTime } from '@/lib/format'
import { useFiles } from '../files-state'
import { baseName, foldersOf } from '../paths'
import { treeQuery } from '../queries'

/** Ids of rows that are not folders: the "+N more" link and a node still being read. */
const MORE = 'more:'
const LOADING = 'loading:'

/** A folder's tooltip: `users/ · 900 files · 20 MB · 120 folders · last change 3 min ago`. */
export function folderTitle(folder: StorageFolderEntry, now = Date.now()): string {
  if (folder.objects === null) return `${folder.prefix} · counting what is under it`
  const parts = [
    folder.prefix,
    `${formatNumber(folder.objects)} ${folder.objects === 1 ? 'file' : 'files'}`,
    formatBytes(folder.bytes ?? 0),
  ]
  if (folder.folders !== null && folder.folders > 0)
    parts.push(`${formatNumber(folder.folders)} ${folder.folders === 1 ? 'folder' : 'folders'}`)
  if (folder.changedAt) parts.push(`last change ${relativeTime(folder.changedAt, now)}`)
  if (folder.empty) parts.push('an empty folder marker')
  return parts.join(' · ')
}

/** A folder's name in the tree: its last segment, `(empty)` for an empty one (`a//`). */
export function folderLabel(prefix: string): string {
  const name = baseName(prefix)
  return name === '' ? '(empty)' : name
}

function folderNode(
  folder: StorageFolderEntry,
  children: readonly PanelTreeNode[] | undefined,
): PanelTreeNode {
  return {
    id: folder.prefix,
    label: folderLabel(folder.prefix),
    icon: folder.empty ? FolderSimpleDashedIcon : FolderIcon,
    count: folder.empty ? 'empty' : folder.objects === null ? '—' : folder.objects,
    title: folderTitle(folder),
    children,
  }
}

/** Placeholders standing for a shut node's folders until it opens, so it has a caret and `+N`. */
function unread(prefix: string, count: number): PanelTreeNode[] {
  return Array.from({ length: Math.min(count, 1_000) }, (_, index) => ({
    id: `${LOADING}${prefix}${index}`,
    label: '…',
  }))
}

export function FolderTree({
  filter,
  onDropFiles,
}: {
  filter: string
  onDropFiles?: ((prefix: string, transfer: DataTransfer) => void) | undefined
}) {
  const files = useFiles()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(foldersOf(files.prefix)),
  )
  // Where you are is always open, with every folder above it; another
  // bucket starts from its root.
  const [seen, setSeen] = useState(`${files.bucket}|${files.prefix}`)
  const here = `${files.bucket}|${files.prefix}`
  if (seen !== here) {
    setSeen(here)
    const next = new Set(seen.startsWith(`${files.bucket}|`) ? expanded : [])
    for (const folder of foldersOf(files.prefix)) next.add(folder)
    setExpanded(next)
  }
  const open = [...expanded]
  const reads = useQueries({
    queries: open.map((prefix) => treeQuery(files.project, files.bucket, prefix)),
  })
  const levels = new Map<string, { page: StorageListPage | undefined; pending: boolean }>()
  open.forEach((prefix, index) => {
    const read = reads[index]
    levels.set(prefix, {
      page: read?.data as StorageListPage | undefined,
      pending: read?.isPending ?? true,
    })
  })

  const childrenOf = (prefix: string, depth: number): PanelTreeNode[] | undefined => {
    const level = levels.get(prefix)
    if (!level) return undefined
    if (!level.page) return level.pending ? [{ id: `${LOADING}${prefix}`, label: '…' }] : []
    const folders = level.page.items.filter(
      (entry): entry is Extract<StorageEntry, { type: 'folder' }> => entry.type === 'folder',
    )
    const nodes = folders.map((folder) =>
      folderNode(
        folder,
        expanded.has(folder.prefix) && depth < 64
          ? childrenOf(folder.prefix, depth + 1)
          : (folder.folders ?? 0) > 0
            ? unread(folder.prefix, folder.folders ?? 0)
            : undefined,
      ),
    )
    // Where you are is always in the tree, even past the first 100 of its level.
    const onPath = foldersOf(files.prefix).find(
      (folder) => folder.length > prefix.length && folder.startsWith(prefix),
    )
    if (onPath !== undefined && !folders.some((folder) => folder.prefix === onPath))
      nodes.push({
        id: onPath,
        label: folderLabel(onPath),
        icon: FolderIcon,
        title: onPath,
        children: expanded.has(onPath) && depth < 64 ? childrenOf(onPath, depth + 1) : undefined,
      })
    const total = level.page.totals.folders ?? folders.length
    if (total > folders.length)
      nodes.push({
        id: `${MORE}${prefix}`,
        label: `+${formatNumber(total - folders.length)} more folders · open in the list`,
      })
    return nodes
  }

  const bucket = files.buckets.buckets.find((entry) => entry.name === files.bucket)
  const root: PanelTreeNode = {
    id: '',
    label: files.bucket,
    icon: HardDrivesIcon,
    count: bucket?.objects ?? undefined,
    title: bucket
      ? bucket.objects === null
        ? `gs://${files.bucket} · counting what is in it`
        : `gs://${files.bucket} · ${formatNumber(bucket.objects)} files · ${formatBytes(bucket.bytes ?? 0)}`
      : `gs://${files.bucket}`,
    children: childrenOf('', 0),
  }

  // Files dragged onto a folder of the tree go into it; the node under the
  // pointer is marked while they hover.
  const [over, setOver] = useState<string | undefined>(undefined)
  const nodeOf = (target: EventTarget) => {
    const id = (target as HTMLElement).closest<HTMLElement>('[data-node-id]')?.dataset.nodeId
    return id === undefined || id.startsWith(MORE) || id.startsWith(LOADING) ? undefined : id
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (!onDropFiles || !Array.from(event.dataTransfer.types).includes('Files')) return
        const id = nodeOf(event.target)
        if (id === undefined) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        if (id !== over) setOver(id)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(undefined)
      }}
      onDrop={(event) => {
        const id = nodeOf(event.target)
        setOver(undefined)
        if (!onDropFiles || id === undefined) return
        event.preventDefault()
        onDropFiles(id, event.dataTransfer)
      }}
    >
      {over !== undefined && (
        // The tree draws its own rows; the drop target is marked by its id.
        <style>{`[data-testid="folder-tree"] [data-node-id="${over.replace(/["\\]/g, (character) => `\\${character}`)}"]{box-shadow:inset 0 0 0 1.5px var(--color-kumo-brand)}`}</style>
      )}
      <PanelTree
        nodes={[root]}
        current={files.prefix}
        expanded={expanded}
        onToggle={(id, isOpen) =>
          setExpanded((current) => {
            const next = new Set(current)
            if (isOpen) next.add(id)
            else next.delete(id)
            return next
          })
        }
        onOpen={(node) => {
          if (node.id.startsWith(LOADING)) return
          if (node.id.startsWith(MORE)) {
            files.goTo(node.id.slice(MORE.length))
            return
          }
          files.goTo(node.id)
        }}
        filter={filter}
        ariaLabel={`Folders of gs://${files.bucket}`}
        empty="No loaded folder is named like that."
        testId="folder-tree"
      />
    </div>
  )
}
