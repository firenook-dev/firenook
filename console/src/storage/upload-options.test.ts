import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeMetadataHeader } from './api'
import {
  EMPTY_OPTIONS,
  type UploadOptions,
  metadataOf,
  optionsKey,
  optionsSummary,
  readOptions,
  typeFor,
  writeOptions,
} from './upload-options'

const options: UploadOptions = {
  typeMode: 'auto',
  contentType: '',
  cacheControl: 'public, max-age=3600',
  contentDisposition: '',
  custom: [
    { id: '1', key: 'ownerUid', value: 'u_k65eq', enabled: true },
    { id: '2', key: 'note', value: 'été', enabled: true },
    { id: '3', key: '', value: '', enabled: true },
  ],
}

function decode(header: string): unknown {
  const body = header.slice('b64.'.length).replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(body.padEnd(Math.ceil(body.length / 4) * 4, '='))
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))),
  )
}

describe('upload options', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('travel in the metadata header, unicode and all', () => {
    const header = encodeMetadataHeader(metadataOf(options))
    expect(header.startsWith('b64.')).toBe(true)
    expect(header).not.toMatch(/[+/=]/)
    expect(decode(header)).toEqual({
      cacheControl: 'public, max-age=3600',
      customMetadata: { ownerUid: 'u_k65eq', note: 'été' },
    })
  })

  it('type each file by its own type, or all by one', () => {
    expect(typeFor({ name: 'a.md', type: '' }, options)).toBe('text/markdown')
    expect(typeFor({ name: 'a.png', type: 'image/png' }, options)).toBe('image/png')
    expect(
      typeFor(
        { name: 'a.png', type: 'image/png' },
        { ...options, typeMode: 'fixed', contentType: 'image/webp' },
      ),
    ).toBe('image/webp')
  })

  it('are remembered per bucket, and storage that refuses is no options', () => {
    writeOptions('demo', 'b', options)
    expect(localStorage.getItem(optionsKey('demo', 'b'))).not.toBeNull()
    expect(readOptions('demo', 'b').cacheControl).toBe('public, max-age=3600')
    expect(readOptions('demo', 'other')).toEqual(EMPTY_OPTIONS)
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readOptions('demo', 'b')).toEqual(EMPTY_OPTIONS)
  })

  it('say what they set', () => {
    expect(optionsSummary(options)).toBe('cacheControl, 2 keys')
    expect(optionsSummary(EMPTY_OPTIONS)).toBe('none')
  })
})
