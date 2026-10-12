import { describe, expect, it } from 'vitest'
import { foldersOf, normalizeFolder, parentFolder, parentOf, rowKeyIn } from './paths'

describe('folders, as GCS has them', () => {
  it('find an object’s folder without collapsing empty segments', () => {
    expect(parentOf('users/u1/avatar.png')).toBe('users/u1/')
    expect(parentOf('avatar.png')).toBe('')
    expect(parentOf('a//b.png')).toBe('a//')
    expect(parentOf('/lead.png')).toBe('/')
  })

  it('go up one folder, and stop at the root', () => {
    expect(parentFolder('users/u1/')).toBe('users/')
    expect(parentFolder('users/')).toBe('')
    expect(parentFolder('a//')).toBe('a/')
    expect(parentFolder('/')).toBe('')
    expect(parentFolder('')).toBe('')
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
