import { describe, expect, it } from 'vitest'
import {
  baseName,
  encodeObjectPath,
  foldersOf,
  gsUrl,
  normalizeFolder,
  parentOf,
  parseLocation,
  relativeName,
  rowKeyIn,
  segments,
  truncationParts,
} from './paths'

describe('folders, as GCS has them', () => {
  it('find an object’s folder without collapsing empty segments', () => {
    expect(parentOf('users/u1/avatar.png')).toBe('users/u1/')
    expect(parentOf('avatar.png')).toBe('')
    expect(parentOf('a//b.png')).toBe('a//')
    expect(parentOf('/lead.png')).toBe('/')
  })

  it('end a folder in one slash, and leave the root and `//` alone', () => {
    expect(normalizeFolder('users')).toBe('users/')
    expect(normalizeFolder('users/')).toBe('users/')
    expect(normalizeFolder('')).toBe('')
    expect(normalizeFolder('a//')).toBe('a//')
    expect(normalizeFolder('/')).toBe('/')
  })

  it('list every folder a name sits in, its own marker last', () => {
    expect(foldersOf('a/b/c.png')).toEqual(['', 'a/', 'a/b/'])
    expect(foldersOf('a//b.png')).toEqual(['', 'a/', 'a//'])
    expect(foldersOf('/lead.png')).toEqual(['', '/'])
    expect(foldersOf('top.png')).toEqual([''])
    expect(foldersOf('drafts/')).toEqual(['', 'drafts/'])
  })

  it('name the row a change is in a folder’s listing', () => {
    expect(rowKeyIn('users/', 'users/u1/avatar.png')).toBe('users/u1/')
    expect(rowKeyIn('users/u1/', 'users/u1/avatar.png')).toBe('users/u1/avatar.png')
    expect(rowKeyIn('', 'top.png')).toBe('top.png')
    expect(rowKeyIn('', '/lead.png')).toBe('/')
    expect(rowKeyIn('a/', 'a//b.png')).toBe('a//')
    expect(rowKeyIn('users/', 'public/x.png')).toBeUndefined()
    expect(rowKeyIn('drafts/', 'drafts/')).toBeUndefined()
    expect(rowKeyIn('', 'drafts/')).toBe('drafts/')
  })
})

describe('the steps to a folder', () => {
  it('names each segment and the folder it opens, empty ones kept', () => {
    expect(segments('users/u1/')).toEqual([
      { label: 'users', prefix: 'users/' },
      { label: 'u1', prefix: 'users/u1/' },
    ])
    expect(segments('a//')).toEqual([
      { label: 'a', prefix: 'a/' },
      { label: '', prefix: 'a//' },
    ])
    expect(segments('/')).toEqual([{ label: '', prefix: '/' }])
    expect(segments('')).toEqual([])
  })

  it('takes the last segment, a folder’s without its slash', () => {
    expect(baseName('users/u1/avatar.png')).toBe('avatar.png')
    expect(baseName('users/u1/')).toBe('u1')
    expect(baseName('top.png')).toBe('top.png')
    expect(baseName('a//')).toBe('')
  })

  it('names a file below a folder as a flat listing shows it', () => {
    expect(relativeName('users/u1/avatar.png', 'users/')).toBe('u1/avatar.png')
    expect(relativeName('users/u1/avatar.png', '')).toBe('users/u1/avatar.png')
    expect(relativeName('public/x', 'users/')).toBe('public/x')
  })

  it('writes gs:// URLs and encodes every slash of a protocol path', () => {
    expect(gsUrl('b', 'users/u1/a.png')).toBe('gs://b/users/u1/a.png')
    expect(gsUrl('b')).toBe('gs://b/')
    expect(encodeObjectPath('users/u1/a b.png')).toBe('users%2Fu1%2Fa%20b.png')
  })
})

describe('where a pasted location points', () => {
  const context = { buckets: ['demo.appspot.com', 'demo-media'], bucket: 'demo.appspot.com' }

  it('reads gs:// URLs', () => {
    expect(parseLocation('gs://demo-media/banners/b.png', context)).toEqual({
      bucket: 'demo-media',
      path: 'banners/b.png',
    })
    expect(parseLocation('gs://demo-media', context)).toEqual({ bucket: 'demo-media', path: '' })
    expect(parseLocation('gs://demo-media/banners/', context)).toEqual({
      bucket: 'demo-media',
      path: 'banners/',
    })
  })

  it('reads an emulator download URL with its encoded name and token', () => {
    expect(
      parseLocation(
        'http://127.0.0.1:9199/v0/b/demo.appspot.com/o/users%2Fu1%2Favatar.png?alt=media&token=abc',
        context,
      ),
    ).toEqual({ bucket: 'demo.appspot.com', path: 'users/u1/avatar.png' })
  })

  it('reads a production download URL', () => {
    expect(
      parseLocation(
        'https://firebasestorage.googleapis.com/v0/b/prod.appspot.com/o/a%20b%2Fc.png?alt=media&token=t',
        context,
      ),
    ).toEqual({ bucket: 'prod.appspot.com', path: 'a b/c.png' })
    expect(
      parseLocation('firebasestorage.googleapis.com/v0/b/demo-media/o/x.png', context),
    ).toEqual({ bucket: 'demo-media', path: 'x.png' })
  })

  it('reads the GCS URLs', () => {
    expect(
      parseLocation('https://storage.googleapis.com/demo-media/banners/b.png', context),
    ).toEqual({ bucket: 'demo-media', path: 'banners/b.png' })
    expect(
      parseLocation('https://storage.googleapis.com/storage/v1/b/demo-media/o/a%2Fb.png', context),
    ).toEqual({ bucket: 'demo-media', path: 'a/b.png' })
    expect(parseLocation('https://demo-media.storage.googleapis.com/a/b.png', context)).toEqual({
      bucket: 'demo-media',
      path: 'a/b.png',
    })
  })

  it('reads the console’s own media URL', () => {
    expect(
      parseLocation(
        'http://127.0.0.1:4000/console/api/v1/storage/object/media?bucket=demo-media&name=a%2Fb.png&g=3',
        context,
      ),
    ).toEqual({ bucket: 'demo-media', path: 'a/b.png' })
  })

  it('takes `bucket/path` for a bucket it knows, and a bare path in the bucket on screen', () => {
    expect(parseLocation('demo-media/banners/', context)).toEqual({
      bucket: 'demo-media',
      path: 'banners/',
    })
    expect(parseLocation('demo-media', context)).toEqual({ bucket: 'demo-media', path: '' })
    expect(parseLocation('users/u1/a.png', context)).toEqual({
      bucket: 'demo.appspot.com',
      path: 'users/u1/a.png',
    })
    expect(parseLocation('   ', context)).toBeUndefined()
    expect(parseLocation('https://example.test/page', context)).toBeUndefined()
  })
})

describe('cutting a long name in the middle', () => {
  it('keeps the extension and a little before it', () => {
    expect(truncationParts('banner-very-long-name-07.png')).toEqual([
      'banner-very-long-nam',
      'e-07.png',
    ])
    expect(truncationParts('short.png')).toEqual(['short.png', ''])
    expect(truncationParts('a-very-long-name-without-extension')).toEqual([
      'a-very-long-name-without-exten',
      'sion',
    ])
  })
})
