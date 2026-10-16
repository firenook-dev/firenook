import { describe, expect, it, vi } from 'vitest'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import { type EntryActions, entryMenu } from './entry-menu'

const file: StorageEntry = {
  type: 'file',
  name: 'users/u1/avatar.png',
  size: 10,
  contentType: 'image/png',
  contentEncoding: null,
  updated: '2026-10-01T00:00:00Z',
  timeCreated: '2026-10-01T00:00:00Z',
  generation: '1',
  tokens: 1,
  metadataKeys: [],
  metadataCount: 0,
}
const folder: StorageEntry = {
  type: 'folder',
  prefix: 'users/u1/',
  objects: 3,
  bytes: 30,
  folders: 0,
  changedAt: null,
  empty: false,
}

function everything(): EntryActions {
  return {
    open: vi.fn(),
    openInNewTab: vi.fn(),
    quickLook: vi.fn(),
    download: vi.fn(),
    copyGsUrl: vi.fn(),
    copyPath: vi.fn(),
    copyDownloadUrl: vi.fn(),
    rename: vi.fn(),
    move: vi.fn(),
    duplicate: vi.fn(),
    copyTo: vi.fn(),
    editMetadata: vi.fn(),
    delete: vi.fn(),
  }
}

describe('a row’s menu', () => {
  it('lists a file’s items in order, Delete last and red', () => {
    const items = entryMenu(file, everything())
    expect(items.map((item) => item.label)).toEqual([
      'Open',
      'Open in new tab',
      'Quick Look',
      'Download',
      'Copy gs:// URL',
      'Copy path',
      'Copy download URL',
      'Rename',
      'Move…',
      'Duplicate',
      'Edit metadata…',
      'Delete',
    ])
    expect(items.at(-1)).toMatchObject({ danger: true, shortcut: 'Delete' })
    expect(items.find((item) => item.id === 'rename')?.shortcut).toBe('F2')
    expect(items.find((item) => item.id === 'copy-path')?.shortcut).toBe('Alt+Mod+c')
    expect(items.find((item) => item.id === 'quick-look')?.shortcut).toBe('Shift+Space')
  })

  it('lists a folder’s, with a zip download and Copy… instead of Duplicate', () => {
    expect(entryMenu(folder, everything()).map((item) => item.label)).toEqual([
      'Open',
      'Open in new tab',
      'Download as .zip',
      'Copy gs:// URL',
      'Copy path',
      'Rename',
      'Move…',
      'Copy…',
      'Delete',
    ])
  })

  it('offers only the actions the page can do', () => {
    const { open, openInNewTab, copyGsUrl, copyPath } = everything()
    expect(
      entryMenu(file, { open, openInNewTab, copyGsUrl, copyPath }).map((item) => item.id),
    ).toEqual(['open', 'open-tab', 'copy-gs', 'copy-path'])
  })

  it('leaves a file without a token without its download URL', () => {
    const items = entryMenu({ ...file, tokens: 0 }, everything())
    expect(items.some((item) => item.id === 'copy-url')).toBe(false)
  })

  it('keeps writes listed with the reason they cannot run', () => {
    const items = entryMenu(file, everything(), {
      noDelete: 'Line 5 refuses this identity a delete.',
    })
    expect(items.find((item) => item.id === 'delete')?.disabled).toBe(
      'Line 5 refuses this identity a delete.',
    )
    expect(items.find((item) => item.id === 'rename')?.disabled).toBeUndefined()
  })

  it('runs the action with its own row', () => {
    const actions = everything()
    entryMenu(file, actions)
      .find((item) => item.id === 'copy-gs')
      ?.run()
    expect(actions.copyGsUrl).toHaveBeenCalledWith(file)
  })
})
