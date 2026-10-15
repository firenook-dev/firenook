import { describe, expect, it } from 'vitest'
import {
  type EntryLike,
  filesFromEntries,
  isSystemFile,
  pastedImage,
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

describe('what a paste brings', () => {
  it('an image, which uploads', () => {
    const image = new File(['x'], 'image.png', { type: 'image/png' })
    const text = new File(['x'], 'notes.txt', { type: 'text/plain' })
    expect(pastedImage([text, image])).toBe(image)
    expect(pastedImage([text])).toBeUndefined()
    expect(pastedImage([])).toBeUndefined()
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
