// One item list per row, whichever way the menu is reached — right-click,
// Shift+F10, the row's ⋯, ⌘K while the row is the cursor — in one order:
// open, look, download, copy, then what changes the object, and the
// destructive item last (the foundation's `RowMenu` puts it after a
// separator, in red). An item that cannot run now stays listed, dimmed,
// with the reason, so the menu never changes shape under the pointer.
//
// The page passes the actions it can do; an action it does not pass is not
// offered at all, which is how a client identity sees no token items and a
// read-only state no write items.

import {
  ArrowSquareOutIcon,
  ArrowsOutCardinalIcon,
  CopyIcon,
  CopySimpleIcon,
  DownloadSimpleIcon,
  EyeIcon,
  FolderOpenIcon,
  LinkSimpleIcon,
  PencilSimpleIcon,
  SlidersHorizontalIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import type { RowMenuItem } from '@/components/console/row-menu'

/** What the page can do with a row; each absent action is an item not offered. */
export interface EntryActions {
  open: (entry: StorageEntry) => void
  openInNewTab: (entry: StorageEntry) => void
  quickLook?: ((entry: StorageEntry) => void) | undefined
  download?: ((entry: StorageEntry) => void) | undefined
  copyGsUrl: (entry: StorageEntry) => void
  copyPath: (entry: StorageEntry) => void
  /** Files that carry a token (Admin only). */
  copyDownloadUrl?: ((entry: StorageEntry) => void) | undefined
  rename?: ((entry: StorageEntry) => void) | undefined
  move?: ((entry: StorageEntry) => void) | undefined
  /** A file's copy beside it. */
  duplicate?: ((entry: StorageEntry) => void) | undefined
  /** A folder's copy somewhere else. */
  copyTo?: ((entry: StorageEntry) => void) | undefined
  editMetadata?: ((entry: StorageEntry) => void) | undefined
  delete?: ((entry: StorageEntry) => void) | undefined
}

/** Why a write cannot run now, when it cannot (an upload in flight, a job, a refusal). */
export interface EntryLimits {
  /** Set while acting as a client that the access check says may not delete this file. */
  noDelete?: string | undefined
  /** Set while writes are not possible at all. */
  noWrite?: string | undefined
}

/** The menu of one row. */
export function entryMenu(
  entry: StorageEntry,
  actions: EntryActions,
  limits: EntryLimits = {},
): RowMenuItem[] {
  const items: RowMenuItem[] = []
  const add = (item: Omit<RowMenuItem, 'run'> & { run?: (() => void) | undefined }) => {
    if (item.run) items.push(item as RowMenuItem)
  }
  const bind = (action: ((entry: StorageEntry) => void) | undefined) =>
    action ? () => action(entry) : undefined
  add({ id: 'open', label: 'Open', icon: FolderOpenIcon, run: bind(actions.open) })
  add({
    id: 'open-tab',
    label: 'Open in new tab',
    icon: ArrowSquareOutIcon,
    run: bind(actions.openInNewTab),
  })
  if (entry.type === 'file') {
    add({
      id: 'quick-look',
      label: 'Quick Look',
      icon: EyeIcon,
      shortcut: 'Shift+Space',
      run: bind(actions.quickLook),
    })
    add({
      id: 'download',
      label: 'Download',
      icon: DownloadSimpleIcon,
      run: bind(actions.download),
    })
  } else {
    add({
      id: 'download',
      label: 'Download as .zip',
      icon: DownloadSimpleIcon,
      run: bind(actions.download),
    })
  }
  add({
    id: 'copy-gs',
    label: 'Copy gs:// URL',
    icon: CopySimpleIcon,
    shortcut: 'Mod+c',
    run: bind(actions.copyGsUrl),
  })
  add({
    id: 'copy-path',
    label: 'Copy path',
    icon: CopySimpleIcon,
    shortcut: 'Alt+Mod+c',
    run: bind(actions.copyPath),
  })
  if (entry.type === 'file' && entry.tokens > 0)
    add({
      id: 'copy-url',
      label: 'Copy download URL',
      icon: LinkSimpleIcon,
      run: bind(actions.copyDownloadUrl),
    })
  const write = limits.noWrite
  add({
    id: 'rename',
    label: 'Rename',
    icon: PencilSimpleIcon,
    shortcut: 'F2',
    disabled: write,
    run: bind(actions.rename),
  })
  add({
    id: 'move',
    label: 'Move…',
    icon: ArrowsOutCardinalIcon,
    disabled: write,
    run: bind(actions.move),
  })
  if (entry.type === 'file') {
    add({
      id: 'duplicate',
      label: 'Duplicate',
      icon: CopyIcon,
      disabled: write,
      run: bind(actions.duplicate),
    })
    add({
      id: 'edit-metadata',
      label: 'Edit metadata…',
      icon: SlidersHorizontalIcon,
      disabled: write,
      run: bind(actions.editMetadata),
    })
  } else {
    add({
      id: 'copy-to',
      label: 'Copy…',
      icon: CopyIcon,
      disabled: write,
      run: bind(actions.copyTo),
    })
  }
  add({
    id: 'delete',
    label: 'Delete',
    icon: TrashIcon,
    shortcut: 'Delete',
    danger: true,
    disabled: write ?? limits.noDelete,
    run: bind(actions.delete),
  })
  return items
}
