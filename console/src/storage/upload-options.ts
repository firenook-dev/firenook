// What a drop's files carry besides their bytes: one content type for all
// or each file's own, a cacheControl, a contentDisposition and custom keys.
// Applied to every file of the drop, sent in each upload's
// `x-firenook-metadata` header, and remembered per bucket in this browser so
// the next drop starts from the last choice.

import type { KeyValueRow } from '@/components/console/key-value-editor'
import type { StorageUploadMetadata } from './api'
import { uploadType } from './mime'

export interface UploadOptions {
  /** `auto`: each file's own type (the browser's, else its extension's); `fixed`: `contentType` for all. */
  typeMode: 'auto' | 'fixed'
  contentType: string
  cacheControl: string
  contentDisposition: string
  custom: KeyValueRow[]
}

export const EMPTY_OPTIONS: UploadOptions = {
  typeMode: 'auto',
  contentType: '',
  cacheControl: '',
  contentDisposition: '',
  custom: [],
}

export function optionsKey(project: string, bucket: string): string {
  return `firenook.console.storage-upload-options.${project}.${bucket}`
}

/** The last options used in this bucket, or none; storage that refuses is no options. */
export function readOptions(project: string, bucket: string): UploadOptions {
  try {
    const raw = localStorage.getItem(optionsKey(project, bucket))
    if (!raw) return EMPTY_OPTIONS
    const parsed = JSON.parse(raw) as Partial<UploadOptions>
    return {
      typeMode: parsed.typeMode === 'fixed' ? 'fixed' : 'auto',
      contentType: typeof parsed.contentType === 'string' ? parsed.contentType : '',
      cacheControl: typeof parsed.cacheControl === 'string' ? parsed.cacheControl : '',
      contentDisposition:
        typeof parsed.contentDisposition === 'string' ? parsed.contentDisposition : '',
      custom: Array.isArray(parsed.custom)
        ? parsed.custom.filter(
            (row): row is KeyValueRow =>
              typeof row === 'object' &&
              row !== null &&
              typeof row.key === 'string' &&
              typeof row.value === 'string' &&
              typeof row.id === 'string',
          )
        : [],
    }
  } catch {
    return EMPTY_OPTIONS
  }
}

export function writeOptions(project: string, bucket: string, options: UploadOptions): void {
  try {
    localStorage.setItem(optionsKey(project, bucket), JSON.stringify(options))
  } catch {
    // Remembered for this page only.
  }
}

/** The custom keys the options set: enabled rows with a key, the last of a repeated key winning. */
export function customOf(options: UploadOptions): Record<string, string> {
  const custom: Record<string, string> = {}
  for (const row of options.custom)
    if (row.enabled && row.key.trim() !== '') custom[row.key.trim()] = row.value
  return custom
}

/** What every upload of the drop carries beside its type. */
export function metadataOf(options: UploadOptions): StorageUploadMetadata {
  const metadata: StorageUploadMetadata = {}
  if (options.cacheControl.trim()) metadata.cacheControl = options.cacheControl.trim()
  if (options.contentDisposition.trim())
    metadata.contentDisposition = options.contentDisposition.trim()
  const custom = customOf(options)
  if (Object.keys(custom).length > 0) metadata.customMetadata = custom
  return metadata
}

/** The type one file uploads with. */
export function typeFor(
  file: { name: string; type: string },
  options: UploadOptions,
): string | undefined {
  if (options.typeMode === 'fixed' && options.contentType.trim()) return options.contentType.trim()
  return uploadType(file)
}

/** What the options set, for their disclosure's summary: "cacheControl, 1 key". */
export function optionsSummary(options: UploadOptions): string {
  const parts: string[] = []
  if (options.typeMode === 'fixed' && options.contentType.trim()) parts.push('contentType')
  if (options.cacheControl.trim()) parts.push('cacheControl')
  if (options.contentDisposition.trim()) parts.push('contentDisposition')
  const keys = Object.keys(customOf(options)).length
  if (keys > 0) parts.push(`${keys} ${keys === 1 ? 'key' : 'keys'}`)
  return parts.length > 0 ? parts.join(', ') : 'none'
}
