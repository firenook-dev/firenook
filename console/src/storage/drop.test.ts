import { describe, expect, it } from 'vitest'
import {
  type EntryLike,
  filesFromEntries,
  isSystemFile,
  pasteMeaning,
  pastedName,
  withoutSystemFiles,
} from './drop'

function file(name: string): EntryLike {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (success) => success(new File([name], name)),
  }
}

function folder(name: string, children: EntryLike[]): EntryLike {
  let read = false
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (success) => {
        // A real reader answers in batches, then with none.
        success(read ? [] : children)
        read = true
      },
    }),
  }
}

describe('what a drop holds', () => {
  it('walks dropped folders into relative names', async () => {
    const dropped = await filesFromEntries([
      file('top.png'),
      folder('photos', [file('a.png'), folder('2026', [file('b.png')])]),
    ])
    expect(dropped.map((entry) => entry.path)).toEqual([
      'photos/2026/b.png',
      'photos/a.png',
      'top.png',
    ])
  })

  it('leaves operating-system litter out and says what it left', () => {
    expect(isSystemFile('photos/.DS_Store')).toBe(true)
    expect(isSystemFile('Thumbs.db')).toBe(true)
    expect(isSystemFile('photo.png')).toBe(false)
    const { files, skipped } = withoutSystemFiles([
      { file: new File([''], '.DS_Store'), path: 'photos/.DS_Store' },
      { file: new File([''], 'a.png'), path: 'photos/a.png' },
    ])
    expect(files.map((entry) => entry.path)).toEqual(['photos/a.png'])
    expect(skipped).toEqual(['photos/.DS_Store'])
  })
})

describe('what a paste means', () => {
  const context = { buckets: ['demo.appspot.com'], bucket: 'demo.appspot.com' }

  it('uploads an image', () => {
    const image = new File(['x'], 'image.png', { type: 'image/png' })
    expect(pasteMeaning({ files: [image], text: '' }, context)).toEqual({
      kind: 'image',
      file: image,
    })
  })

  it('offers a copy of a file of this project', () => {
    expect(pasteMeaning({ files: [], text: 'gs://demo.appspot.com/users/a.png' }, context)).toEqual(
      {
        kind: 'location',
        location: { bucket: 'demo.appspot.com', path: 'users/a.png' },
      },
    )
  })

  it('does nothing with other text, another project’s file or a folder', () => {
    expect(pasteMeaning({ files: [], text: 'hello' }, context).kind).toBe('none')
    expect(pasteMeaning({ files: [], text: 'gs://elsewhere/a.png' }, context).kind).toBe('none')
    expect(pasteMeaning({ files: [], text: 'gs://demo.appspot.com/users/' }, context).kind).toBe(
      'none',
    )
  })

  it('names a pasted image by the moment', () => {
    expect(pastedName(new Date(2026, 9, 12, 9, 15, 4), 'image/png')).toBe(
      'pasted-20261012-091504.png',
    )
    expect(pastedName(new Date(2026, 0, 2, 3, 4, 5), 'image/jpeg')).toBe(
      'pasted-20260102-030405.jpg',
    )
  })
})
