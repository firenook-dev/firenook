import { describe, expect, it, vi } from 'vitest'
import type { FilesState } from './files-state'
import { storagePaletteGroups } from './palette'

function state(update = vi.fn()): FilesState {
  return {
    project: 'demo',
    buckets: {
      defaultBucket: 'demo.appspot.com',
      rulesMode: 'perBucket',
      indexReady: true,
      buckets: [
        {
          name: 'demo.appspot.com',
          isDefault: true,
          configured: true,
          served: true,
          rulesFile: 'storage.rules',
          objects: 3,
          bytes: 30,
          inFlight: { uploads: 0, bytes: 0 },
        },
        {
          name: 'demo-media',
          isDefault: false,
          configured: true,
          served: true,
          rulesFile: 'm.rules',
          objects: 31,
          bytes: 1024,
          inFlight: { uploads: 0, bytes: 0 },
        },
      ],
    },
    bucket: 'demo.appspot.com',
    prefix: 'users/',
    object: undefined,
    tab: 'details',
    layout: 'list',
    sort: 'name:asc',
    q: '',
    flat: false,
    viewAs: { kind: 'owner' },
    admin: true,
    search: {} as FilesState['search'],
    update,
    goTo: vi.fn(),
    setBucket: vi.fn(),
    openObject: vi.fn(),
    setViewAs: vi.fn(),
  }
}

const actions = {
  uploadFiles: vi.fn(),
  uploadFolder: vi.fn(),
  showSessions: vi.fn(),
  emptyBucket: vi.fn(),
}

describe('Storage in ⌘K', () => {
  it('opens a pasted location, the file in its folder', () => {
    const update = vi.fn()
    const groups = storagePaletteGroups('gs://demo.appspot.com/users/u1/avatar.png', {
      files: state(update),
      recents: [],
      folders: [],
      actions,
    })
    expect(groups[0]?.label).toBe('Go to')
    const item = groups[0]?.items[0]
    expect(item?.title).toBe('Open gs://demo.appspot.com/users/u1/avatar.png')
    expect(item?.ref).toEqual({
      kind: 'storage.object',
      key: 'demo.appspot.com|users/u1/avatar.png',
    })
    item?.run()
    expect(update).toHaveBeenCalledWith({
      path: 'users/u1/',
      object: 'users/u1/avatar.png',
      q: undefined,
    })
  })

  it('lists recents, folders, other buckets and the page’s actions', () => {
    const groups = storagePaletteGroups('', {
      files: state(),
      recents: [{ path: 'users/u1/', kind: 'folder', at: 1 }],
      folders: ['users/u1/', 'users/u2/'],
      actions,
    })
    expect(groups.map((group) => group.label)).toEqual(['Recent', 'Folders', 'Buckets', 'Storage'])
    expect(
      groups.find((group) => group.label === 'Buckets')?.items.map((item) => item.title),
    ).toEqual(['Switch to bucket demo-media'])
    expect(groups.find((group) => group.label === 'Folders')?.items[0]?.ref).toEqual({
      kind: 'storage.folder',
      key: 'demo.appspot.com|users/u1/',
    })
    const titles = groups
      .find((group) => group.label === 'Storage')
      ?.items.map((item) => item.title)
    expect(titles).toContain('Upload files')
    expect(titles).toContain('Download this folder as .zip')
    expect(titles).toContain('Empty the bucket…')
  })

  it('narrows by the words typed', () => {
    const groups = storagePaletteGroups('upload folder', {
      files: state(),
      recents: [],
      folders: [],
      actions,
    })
    expect(groups.flatMap((group) => group.items.map((item) => item.title))).toEqual([
      'Upload a folder',
    ])
  })
})
