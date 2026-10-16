import { describe, expect, it } from 'vitest'
import type { StorageSniffed } from '@/api/generated/storage/StorageSniffed'
import {
  type ContentFacts,
  contentTypeMismatch,
  decodeText,
  hexRows,
  languageOf,
  parseCsv,
  previewKind,
  trimPartialCharacter,
  withArticle,
} from './content'

const sniff = (
  mime: string,
  family: StorageSniffed['family'],
  definite = true,
): StorageSniffed => ({
  mime,
  family,
  definite,
})

function facts(partial: Partial<ContentFacts>): ContentFacts {
  return {
    name: 'file',
    contentType: null,
    contentEncoding: null,
    size: 10,
    sniffed: null,
    ...partial,
  }
}

describe('how a file previews', () => {
  it('reads the declared type, then the extension', () => {
    expect(previewKind(facts({ contentType: 'image/png', name: 'a.bin' }))).toBe('image')
    expect(previewKind(facts({ contentType: 'video/mp4' }))).toBe('video')
    expect(previewKind(facts({ contentType: 'audio/wav' }))).toBe('audio')
    expect(previewKind(facts({ contentType: 'application/pdf' }))).toBe('pdf')
    expect(previewKind(facts({ name: 'a.json' }))).toBe('json')
    expect(previewKind(facts({ contentType: 'text/csv' }))).toBe('csv')
    expect(previewKind(facts({ contentType: 'text/html' }))).toBe('html')
    expect(previewKind(facts({ contentType: 'text/markdown' }))).toBe('text')
    expect(previewKind(facts({ contentType: 'image/svg+xml' }))).toBe('image')
  })

  it('lets a definite signature decide when the type says nothing', () => {
    expect(
      previewKind(
        facts({ contentType: 'application/octet-stream', sniffed: sniff('image/png', 'image') }),
      ),
    ).toBe('image')
    expect(previewKind(facts({ sniffed: sniff('text/plain', 'text', false) }))).toBe('text')
    expect(previewKind(facts({ sniffed: sniff('application/x-elf', 'binary') }))).toBe('binary')
  })

  it('shows zips, zip containers and other archives as their bytes', () => {
    expect(previewKind(facts({ contentType: 'application/zip' }))).toBe('binary')
    expect(
      previewKind(
        facts({
          name: 'r.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ),
    ).toBe('binary')
    expect(previewKind(facts({ contentType: 'application/gzip' }))).toBe('binary')
  })
})

describe('the language a text is highlighted in', () => {
  it('follows the type, then the name', () => {
    expect(languageOf('application/json', 'x')).toBe('json')
    expect(languageOf('text/javascript', 'x')).toBe('javascript')
    expect(languageOf(null, 'a.ts')).toBe('javascript')
    expect(languageOf('image/svg+xml', 'x.svg')).toBe('xml')
    expect(languageOf('application/yaml', 'x')).toBe('yaml')
    expect(languageOf('text/markdown', 'x')).toBe('markdown')
    expect(languageOf('text/css', 'x')).toBe('css')
    expect(languageOf('text/html', 'x')).toBe('html')
    expect(languageOf('text/plain', 'storage.rules')).toBe('rules')
    expect(languageOf('text/plain', 'notes.txt')).toBe('text')
  })
})

describe('bytes as text', () => {
  it('drops a BOM and says whether every byte was UTF-8', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toEqual({
      text: 'hi',
      valid: true,
      bom: true,
    })
    expect(decodeText(new Uint8Array([0x68, 0xff])).valid).toBe(false)
  })

  it('leaves a character cut at the cap out rather than as a fault', () => {
    const bytes = new TextEncoder().encode('été')
    expect(decodeText(trimPartialCharacter(bytes.subarray(0, 4))).text).toBe('ét')
    expect(trimPartialCharacter(bytes)).toBe(bytes)
  })
})

describe('a CSV’s first rows', () => {
  it('keeps quoted commas, quotes and line breaks whole', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",3\n').rows).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', '3'],
    ])
  })

  it('stops at the row limit and says so', () => {
    const text = Array.from({ length: 1_500 }, (_, index) => `${index}`).join('\n')
    const { rows, truncated } = parseCsv(text)
    expect(rows).toHaveLength(1_000)
    expect(truncated).toBe(true)
  })

  it('reads a TSV with its own separator and CRLF lines', () => {
    expect(parseCsv('a\tb\r\n1\t2', { separator: '\t' }).rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('the hex view', () => {
  it('writes sixteen bytes a row with their offset and what prints', () => {
    const rows = hexRows(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: 14 }, () => 0x41)]),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.offset).toBe('00000000')
    expect(rows[0]?.hex.slice(0, 4)).toEqual(['89', '50', '4e', '47'])
    expect(rows[0]?.ascii.slice(0, 4)).toBe('.PNG')
    expect(rows[1]?.offset).toBe('00000010')
  })
})

describe('a content type that disagrees with the bytes', () => {
  it('warns for a generic type over a definite signature', () => {
    expect(
      contentTypeMismatch(
        facts({ contentType: 'application/octet-stream', sniffed: sniff('image/png', 'image') }),
      ),
    ).toBe('image/png')
    expect(
      contentTypeMismatch(facts({ contentType: null, sniffed: sniff('application/pdf', 'pdf') })),
    ).toBe('application/pdf')
  })

  it('warns for a PNG type holding JPEG bytes', () => {
    expect(
      contentTypeMismatch(
        facts({ contentType: 'image/png', sniffed: sniff('image/jpeg', 'image') }),
      ),
    ).toBe('image/jpeg')
  })

  it('is quiet for zip containers, text, a contentEncoding and an agreeing type', () => {
    expect(
      contentTypeMismatch(
        facts({
          name: 'r.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sniffed: sniff('application/zip', 'archive'),
        }),
      ),
    ).toBeUndefined()
    for (const type of [
      'application/json',
      'text/csv',
      'image/svg+xml',
      'text/javascript',
      'text/markdown',
    ])
      expect(
        contentTypeMismatch(
          facts({ contentType: type, sniffed: sniff('text/plain', 'text', false) }),
        ),
      ).toBeUndefined()
    expect(
      contentTypeMismatch(
        facts({
          contentType: 'application/json',
          contentEncoding: 'gzip',
          sniffed: sniff('application/gzip', 'archive'),
        }),
      ),
    ).toBeUndefined()
    expect(
      contentTypeMismatch(
        facts({ contentType: 'image/png', sniffed: sniff('image/png', 'image') }),
      ),
    ).toBeUndefined()
    expect(
      contentTypeMismatch(
        facts({ contentType: 'video/mp4', sniffed: sniff('video/quicktime', 'video') }),
      ),
    ).toBeUndefined()
  })

  it('names the format with the article a reader says', () => {
    expect(withArticle('PNG image')).toBe('a PNG image')
    expect(withArticle('MP4 video')).toBe('an MP4 video')
    expect(withArticle('AVIF image')).toBe('an AVIF image')
    expect(withArticle('gzip stream')).toBe('a gzip stream')
  })
})
