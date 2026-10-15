// What an object's bytes are and how the inspector shows them: the preview
// a file gets (from its declared type, its extension, and what its first
// bytes say), the language its text is highlighted in, text decoded with a
// BOM or invalid bytes, a CSV's first rows, hex rows, and the one warning
// about metadata the console makes — a content type that disagrees with the
// bytes, said only when it is surely wrong.

import type { StorageSniffed } from '@/api/generated/storage/StorageSniffed'
import { essence, fileFamily, typeFromName } from './mime'

/** How a file previews. */
export type PreviewKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'json'
  | 'csv'
  | 'html'
  | 'binary'

/** What the content helpers read of an object. */
export interface ContentFacts {
  name: string
  contentType: string | null
  contentEncoding: string | null
  size: number
  sniffed: StorageSniffed | null
}

/** Types that say nothing about the bytes. */
export function isGenericType(contentType: string | null | undefined): boolean {
  const type = essence(contentType)
  return type === '' || type === 'application/octet-stream' || type === 'binary/octet-stream'
}

/** A zip: a `.zip`, or a container that is one (`.docx`, `.xlsx`, `.epub`, `.jar`, `.apk`). */
function isZip(facts: ContentFacts): boolean {
  if (facts.sniffed?.mime === 'application/zip') return true
  const type = essence(facts.contentType) || typeFromName(facts.name) || ''
  return (
    type === 'application/zip' ||
    type === 'application/x-zip-compressed' ||
    type === 'application/epub+zip' ||
    type === 'application/java-archive' ||
    type === 'application/vnd.android.package-archive' ||
    type.startsWith('application/vnd.openxmlformats')
  )
}

/** The preview a file gets. A generic type defers to a definite signature, then to the extension. */
export function previewKind(facts: ContentFacts): PreviewKind {
  const declared = essence(facts.contentType)
  if (
    declared === 'text/html' ||
    (isGenericType(facts.contentType) && /\.html?$/i.test(facts.name))
  )
    return 'html'
  let family = fileFamily(facts.contentType, facts.name)
  const sniffed = facts.sniffed
  if (isGenericType(facts.contentType) && sniffed?.definite) family = familyOfSniff(sniffed)
  switch (family) {
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
      return family
    case 'json':
      return 'json'
    case 'csv':
      return 'csv'
    case 'code':
    case 'text':
      return 'text'
    case 'archive':
      return 'binary'
    case 'binary':
      // Valid UTF-8 with no signature reads as text.
      return sniffed?.family === 'text' ? 'text' : 'binary'
  }
}

function familyOfSniff(sniffed: StorageSniffed): ReturnType<typeof fileFamily> {
  switch (sniffed.family) {
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
    case 'archive':
    case 'text':
    case 'binary':
      return sniffed.family
  }
}

/** The editor languages a text preview uses. */
export type PreviewLanguage =
  | 'json'
  | 'javascript'
  | 'xml'
  | 'yaml'
  | 'markdown'
  | 'css'
  | 'html'
  | 'rules'
  | 'text'

/** The language a text is highlighted in, from its type and name. */
export function languageOf(contentType: string | null | undefined, name: string): PreviewLanguage {
  const lower = name.toLowerCase()
  if (lower.endsWith('.rules')) return 'rules'
  const type = isGenericType(contentType) ? (typeFromName(name) ?? '') : essence(contentType)
  if (type === 'application/json' || type.endsWith('+json') || type === 'application/x-ndjson')
    return 'json'
  if (/(java|type)script$/.test(type)) return 'javascript'
  if (type === 'text/html') return 'html'
  if (type === 'text/css') return 'css'
  if (type.endsWith('xml')) return 'xml'
  if (type.endsWith('yaml')) return 'yaml'
  if (type === 'text/markdown') return 'markdown'
  return 'text'
}

/** Bytes as text: UTF-8 without its BOM, and whether every byte was valid. */
export function decodeText(bytes: Uint8Array): { text: string; valid: boolean; bom: boolean } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = bom ? bytes.subarray(3) : bytes
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), valid: true, bom }
  } catch {
    return { text: new TextDecoder('utf-8').decode(body), valid: false, bom }
  }
}

/**
 * Bytes cut at a preview's cap may end inside a UTF-8 sequence; the
 * partial character is dropped rather than decoded as a fault.
 */
export function trimPartialCharacter(bytes: Uint8Array): Uint8Array {
  let end = bytes.length
  for (let back = 1; back <= 3 && end - back >= 0; back += 1) {
    const byte = bytes[end - back] ?? 0
    if ((byte & 0xc0) === 0x80) continue
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    if (need > back) end -= back
    break
  }
  return end === bytes.length ? bytes : bytes.subarray(0, end)
}

/** The first rows of a CSV (or TSV), quoted fields with commas and newlines kept whole. */
export function parseCsv(
  text: string,
  options: { separator?: string; maxRows?: number } = {},
): { rows: string[][]; truncated: boolean } {
  const separator = options.separator ?? ','
  const maxRows = options.maxRows ?? 1_000
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let index = 0
  while (index < text.length) {
    const character = text[index] ?? ''
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else quoted = false
      } else field += character
    } else if (character === '"' && field === '') quoted = true
    else if (character === separator) {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (rows.length >= maxRows) return { rows, truncated: index + 1 < text.length }
    } else field += character
    index += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return { rows, truncated: false }
}

/** One row of a hex view: the offset, sixteen bytes in hex, and those that print. */
export interface HexRow {
  offset: string
  hex: string[]
  ascii: string
}

/** The hex view's rows: sixteen bytes each, offsets from `base`. */
export function hexRows(bytes: Uint8Array, base = 0): HexRow[] {
  const rows: HexRow[] = []
  for (let start = 0; start < bytes.length; start += 16) {
    const slice = bytes.subarray(start, Math.min(start + 16, bytes.length))
    const hex: string[] = []
    let ascii = ''
    for (const byte of slice) {
      hex.push(byte.toString(16).padStart(2, '0'))
      ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
    }
    rows.push({ offset: (base + start).toString(16).padStart(8, '0'), hex, ascii })
  }
  return rows
}

/** What a definite signature is called in English: "PNG image", "ZIP archive". */
export function describeSignature(mime: string): string {
  const named: Record<string, string> = {
    'image/png': 'PNG image',
    'image/jpeg': 'JPEG image',
    'image/gif': 'GIF image',
    'image/webp': 'WebP image',
    'image/avif': 'AVIF image',
    'image/bmp': 'BMP image',
    'image/x-icon': 'ICO image',
    'application/pdf': 'PDF document',
    'application/zip': 'ZIP archive',
    'application/gzip': 'gzip stream',
    'video/mp4': 'MP4 video',
    'video/webm': 'WebM video',
    'audio/mpeg': 'MP3 audio',
    'audio/wav': 'WAV audio',
    'audio/ogg': 'Ogg audio',
    'application/wasm': 'WebAssembly module',
  }
  return named[mime] ?? mime
}

const BINARY_FAMILIES = new Set(['image', 'video', 'audio', 'pdf'])

/**
 * The content type the bytes call for, when the metadata is surely wrong:
 * a generic (or absent) type over a definite signature, or a binary type
 * that names another format than the signature (`image/png` holding JPEG).
 * Never for text (JSON, CSV, SVG, JS and Markdown all read as text), never
 * for a zip container (`.docx` is a zip), never with a `contentEncoding`
 * (the stored bytes are the encoding's, not the type's).
 */
export function contentTypeMismatch(facts: ContentFacts): string | undefined {
  const sniffed = facts.sniffed
  if (!sniffed?.definite || sniffed.family === 'text') return undefined
  if (facts.contentEncoding) return undefined
  const declared = essence(facts.contentType)
  if (isGenericType(facts.contentType)) return sniffed.mime
  if (sniffed.mime === 'application/zip' && isZip(facts)) return undefined
  const declaredFamily = fileFamily(declared, facts.name)
  if (
    declaredFamily === 'text' ||
    declaredFamily === 'json' ||
    declaredFamily === 'csv' ||
    declaredFamily === 'code'
  )
    return undefined
  if (!BINARY_FAMILIES.has(declaredFamily) || !BINARY_FAMILIES.has(sniffed.family)) return undefined
  if (declaredFamily !== sniffed.family) return sniffed.mime
  // Within images the format is the type: a PNG type over JPEG bytes is wrong.
  if (declaredFamily === 'image' && declared !== sniffed.mime && declared !== 'image/jpg')
    return sniffed.mime
  return undefined
}

/** "a PNG image", "an MP4 video", "an AVIF image": the article an English reader says. */
export function withArticle(phrase: string): string {
  const first = phrase[0] ?? ''
  const acronym = /^[A-Z]{2}/.test(phrase)
  const vowelSound = /[AEIOUaeiou]/.test(first) || (acronym && /[FHLMNRSX]/.test(first))
  return `${vowelSound ? 'an' : 'a'} ${phrase}`
}
