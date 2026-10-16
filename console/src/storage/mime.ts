// A content type for a file the browser could not type: `File.type` is
// empty for many extensions (`.md`, `.yaml`, `.ts`, `.webmanifest`), and an
// upload without a type is stored as `application/octet-stream`, which then
// downloads instead of displaying. The table covers what apps upload; a
// name it does not know stays untyped, which is what the SDK does too.

const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  opus: 'audio/opus',
  pdf: 'application/pdf',
  json: 'application/json',
  geojson: 'application/geo+json',
  webmanifest: 'application/manifest+json',
  ndjson: 'application/x-ndjson',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  css: 'text/css',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  rules: 'text/plain',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  apk: 'application/vnd.android.package-archive',
}

/** The type a name's extension stands for, or `undefined` for one this table does not know. */
export function typeFromName(name: string): string | undefined {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  return TYPES[base.slice(dot + 1).toLowerCase()]
}

/** What an upload of `file` is typed as: the browser's type, else the extension's. */
export function uploadType(file: { name: string; type: string }): string | undefined {
  return file.type || typeFromName(file.name)
}

/** What a file is, for its icon and how it previews. */
export type FileFamily =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'archive'
  | 'json'
  | 'csv'
  | 'code'
  | 'text'
  | 'binary'

/** A type's essence: `text/plain; charset=utf-8` → `text/plain`. */
export function essence(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

const CODE_TYPES = new Set([
  'text/javascript',
  'application/javascript',
  'text/typescript',
  'application/typescript',
  'text/css',
  'text/html',
  'application/xml',
  'text/xml',
  'image/svg+xml',
  'application/yaml',
  'text/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-sh',
])

const ARCHIVE_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/java-archive',
  'application/epub+zip',
  'application/vnd.android.package-archive',
])

/**
 * A file's family from its type, then its extension when the type says
 * nothing useful (absent or `application/octet-stream`). SVG is drawn as an
 * image where a picture is wanted and read as code where text is.
 */
export function fileFamily(contentType: string | null | undefined, name: string): FileFamily {
  const declared = essence(contentType)
  const generic =
    declared === '' || declared === 'application/octet-stream' || declared === 'binary/octet-stream'
  const type = generic ? (typeFromName(name) ?? declared) : declared
  if (type === 'image/svg+xml' || type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'pdf'
  if (ARCHIVE_TYPES.has(type) || type.startsWith('application/vnd.openxmlformats')) return 'archive'
  if (type === 'application/json' || type.endsWith('+json') || type === 'application/x-ndjson')
    return 'json'
  if (type === 'text/csv' || type === 'text/tab-separated-values') return 'csv'
  if (CODE_TYPES.has(type)) return 'code'
  if (type.startsWith('text/')) return 'text'
  return 'binary'
}
