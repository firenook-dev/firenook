// The Metadata tab's one draft: the standard fields and the custom keys of
// the object as it was opened, edited, and turned back into the smallest
// patch that makes the object say what the draft says — a field left alone
// is not sent, a field emptied is cleared (`null`), a renamed key is the old
// one removed and the new one set. The Save button counts what the patch
// changes; problems (an empty key, a key twice, a key over GCS's 1,024
// bytes, the reserved token key) are said on the row they are on. The
// values each standard field suggests are here too, the one list every
// place metadata is typed offers (`fieldSuggestions`).

import type { StorageMetadataPatch } from '@/api/generated/storage/StorageMetadataPatch'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { type KeyValueRow, rowId } from '@/components/console/key-value-editor'
import { typeFromName } from './mime'
import { baseName } from './paths'

/** The standard fields the tab edits, in the order it shows them. */
export const STANDARD_FIELDS = [
  'contentType',
  'cacheControl',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
] as const

export type StandardField = (typeof STANDARD_FIELDS)[number]

const COMMON_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'application/json',
  'text/plain',
  'text/html',
  'text/css',
  'text/javascript',
  'text/csv',
  'application/pdf',
  'video/mp4',
  'audio/mpeg',
  'application/zip',
  'application/octet-stream',
]
const CACHE_PRESETS = [
  'public, max-age=3600',
  'public, max-age=31536000, immutable',
  'private, max-age=0',
  'no-cache',
  'no-store',
]
const DISPOSITIONS = ['inline', 'attachment']
const ENCODINGS = ['gzip', 'br', 'deflate', 'identity']

/** Each value once, in order, the empty ones left out. */
function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

/**
 * What a standard field's box suggests, wherever metadata is typed. Given
 * the file it describes (the Metadata tab), the type its bytes say and the
 * type of its name come first, and a disposition names the file.
 */
export function fieldSuggestions(
  field: StandardField,
  object?: Pick<StorageObjectDetail, 'name' | 'sniffed'>,
): string[] {
  switch (field) {
    case 'contentType':
      return unique([
        object?.sniffed?.definite ? object.sniffed.mime : undefined,
        object ? typeFromName(object.name) : undefined,
        ...COMMON_TYPES,
      ])
    case 'cacheControl':
      return CACHE_PRESETS
    case 'contentDisposition':
      return object
        ? [...DISPOSITIONS, `attachment; filename="${baseName(object.name)}"`]
        : DISPOSITIONS
    case 'contentEncoding':
      return ENCODINGS
    case 'contentLanguage':
      return []
  }
}

export interface MetadataDraft {
  fields: Record<StandardField, string>
  custom: KeyValueRow[]
}

/** The key the engine keeps download tokens under; tokens are managed in Details. */
export const RESERVED_KEY = 'firebaseStorageDownloadTokens'

/** The most bytes a custom key may take. */
const KEY_BYTES = 1_024

/** The draft of an object as it is. */
export function draftOf(
  object: Pick<StorageObjectDetail, StandardField | 'customMetadata'>,
): MetadataDraft {
  const fields = {} as Record<StandardField, string>
  for (const field of STANDARD_FIELDS) fields[field] = object[field] ?? ''
  return {
    fields,
    custom: Object.entries(object.customMetadata)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ id: rowId(), key, value, enabled: true })),
  }
}

/** The custom keys a draft names, the last of a repeated key winning, blank keys left out. */
function customOf(rows: readonly KeyValueRow[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of rows) if (row.key.trim() !== '') map.set(row.key.trim(), row.value)
  return map
}

/** The patch that turns `base` into `draft`: changed fields only, `null` for a field emptied. */
export function patchOf(base: MetadataDraft, draft: MetadataDraft): StorageMetadataPatch {
  const patch: StorageMetadataPatch = {}
  for (const field of STANDARD_FIELDS) {
    const before = base.fields[field].trim()
    const after = draft.fields[field].trim()
    if (before !== after) patch[field] = after === '' ? null : after
  }
  const before = customOf(base.custom)
  const after = customOf(draft.custom)
  const custom: Record<string, string | null> = {}
  for (const [key, value] of after) if (before.get(key) !== value) custom[key] = value
  for (const key of before.keys()) if (!after.has(key)) custom[key] = null
  if (Object.keys(custom).length > 0) patch.customMetadata = custom
  return patch
}

/** How many fields and keys a patch changes: the Save button's figure. */
export function changeCount(patch: StorageMetadataPatch): number {
  let count = 0
  for (const field of STANDARD_FIELDS) if (patch[field] !== undefined) count += 1
  return count + Object.keys(patch.customMetadata ?? {}).length
}

/** The standard fields a patch changes, for the unsaved marks beside their names. */
export function changedFields(patch: StorageMetadataPatch): Set<StandardField> {
  return new Set(STANDARD_FIELDS.filter((field) => patch[field] !== undefined))
}

/** Why a custom key cannot be saved, or `undefined` when it can (duplicates are the editor's). */
export function customKeyProblem(key: string): string | undefined {
  if (key === RESERVED_KEY)
    return 'The engine keeps download tokens here; manage tokens in Details.'
  if (new TextEncoder().encode(key).length > KEY_BYTES)
    return `A custom key takes at most ${KEY_BYTES.toLocaleString('en-US')} bytes.`
  return undefined
}

/** Every problem the draft has, by row: what blocks Save. */
export function draftProblems(draft: MetadataDraft): Map<string, string> {
  const problems = new Map<string, string>()
  const seen = new Map<string, string>()
  for (const row of draft.custom) {
    const key = row.key.trim()
    if (key === '') {
      if (row.value !== '') problems.set(row.id, 'This row needs a key.')
      continue
    }
    const refused = customKeyProblem(key)
    if (refused) {
      problems.set(row.id, refused)
      continue
    }
    const first = seen.get(key)
    if (first !== undefined) problems.set(row.id, `${key} is already a key above.`)
    else seen.set(key, row.id)
  }
  return problems
}

/**
 * The metadata an upload of new bytes carries so that it keeps what the
 * object says now with the draft's edits on top: an edit in place is one
 * write and one event, whether the text, the metadata or both changed.
 */
export function uploadMetadataOf(draft: MetadataDraft): {
  contentType: string | undefined
  cacheControl: string | undefined
  contentDisposition: string | undefined
  contentEncoding: string | undefined
  contentLanguage: string | undefined
  customMetadata: Record<string, string>
} {
  const value = (field: StandardField) => draft.fields[field].trim() || undefined
  return {
    contentType: value('contentType'),
    cacheControl: value('cacheControl'),
    contentDisposition: value('contentDisposition'),
    contentEncoding: value('contentEncoding'),
    contentLanguage: value('contentLanguage'),
    customMetadata: Object.fromEntries(customOf(draft.custom)),
  }
}
