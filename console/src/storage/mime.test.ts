import { describe, expect, it } from 'vitest'
import { essence, fileFamily, typeFromName, uploadType } from './mime'

describe('types for files the browser could not type', () => {
  it('reads the extension, any case, of the last segment only', () => {
    expect(typeFromName('docs/readme.MD')).toBe('text/markdown')
    expect(typeFromName('a.b/config.yaml')).toBe('application/yaml')
    expect(typeFromName('Makefile')).toBeUndefined()
    expect(typeFromName('.env')).toBeUndefined()
    expect(typeFromName('photo.unknownext')).toBeUndefined()
  })

  it('prefers the browser’s type and falls back to the extension', () => {
    expect(uploadType({ name: 'x.png', type: 'image/webp' })).toBe('image/webp')
    expect(uploadType({ name: 'x.md', type: '' })).toBe('text/markdown')
    expect(uploadType({ name: 'blob', type: '' })).toBeUndefined()
  })
})

describe('what a file is', () => {
  it('reads the declared type, then the name when the type says nothing', () => {
    expect(fileFamily('image/png', 'a.bin')).toBe('image')
    expect(fileFamily('application/octet-stream', 'a.png')).toBe('image')
    expect(fileFamily(null, 'a.json')).toBe('json')
    expect(fileFamily('text/csv; charset=utf-8', 'a')).toBe('csv')
    expect(
      fileFamily(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'r.docx',
      ),
    ).toBe('archive')
    expect(fileFamily('text/javascript', 'a.js')).toBe('code')
    expect(fileFamily('text/markdown', 'a.md')).toBe('text')
    expect(fileFamily('application/pdf', 'a')).toBe('pdf')
    expect(fileFamily(null, 'blob')).toBe('binary')
    expect(essence(' Text/Plain ; charset=utf-8')).toBe('text/plain')
  })
})
