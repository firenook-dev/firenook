// Taking data out of the page you are looking at.
//
// The grid reads previews — a cell draws one line, so a page of documents
// carrying large maps need not ship every byte. An export must not: it
// reads whole documents, pages through the whole result with the same
// cursors the grid uses, and never writes a truncated value to a file
// someone will import somewhere else.
//
// Rules apply. An export made while viewing as a user contains what that
// user can read, which is the honest answer and the one worth having when
// the question is "what does my app see".

import { create } from 'zustand'
import { type WorkbenchQuery, toStructuredQuery } from './query'
import { cursorAfter, splitCollection } from './queries'
import { type FirestoreScope, documentRoot, runQuery } from './rest'
import { type FsDocument, type RestValue, encodeFields, fieldsToJson } from './value'

/** Documents per request while exporting. Larger than the grid's page: no
 *  one is watching these arrive, and each round trip costs more than the
 *  rows do. */
export const EXPORT_PAGE = 500

export type ExportFormat = 'json' | 'ndjson' | 'csv'

export interface ExportFormatInfo {
  id: ExportFormat
  label: string
  extension: string
  mediaType: string
  /** What the file is good for, in one line. */
  note: string
}

export const EXPORT_FORMATS: readonly [ExportFormatInfo, ...ExportFormatInfo[]] = [
  {
    id: 'json',
    label: 'JSON',
    extension: 'json',
    mediaType: 'application/json',
    note: 'One object keyed by document id — the shape this console imports.',
  },
  {
    id: 'ndjson',
    label: 'NDJSON',
    extension: 'ndjson',
    mediaType: 'application/x-ndjson',
    note: 'One document per line, for streaming into another tool.',
  },
  {
    id: 'csv',
    label: 'CSV',
    extension: 'csv',
    mediaType: 'text/csv',
    note: 'Flattened columns for a spreadsheet; nested keys join with a dot.',
  },
]

export interface ExportOptions {
  format: ExportFormat
  /**
   * Keep every Firestore type exactly, in the REST wire shape, instead of
   * the plain JSON a person can read. References, bytes, geopoints and
   * vectors have no plain-JSON form that survives a round trip, so an
   * export meant to be loaded back somewhere typed needs this.
   */
  typed: boolean
}

/** A document as one JSON value, in whichever shape was asked for. */
export function documentToJson(
  document: FsDocument,
  options: ExportOptions,
  root: string,
): unknown {
  return options.typed ? encodeFields(document.fields, root) : fieldsToJson(document.fields)
}

/**
 * Every column a CSV needs, in first-seen order with nested maps flattened
 * to dotted keys. An array or a value with no plain form stays in its own
 * column as JSON, because splitting it across columns would invent a shape
 * the data does not have.
 */
export function csvColumns(documents: readonly FsDocument[]): string[] {
  const columns: string[] = []
  const seen = new Set<string>()
  const walk = (fields: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(fields)) {
      const name = prefix ? `${prefix}.${key}` : key
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, name)
        continue
      }
      if (!seen.has(name)) {
        seen.add(name)
        columns.push(name)
      }
    }
  }
  for (const document of documents) walk(fieldsToJson(document.fields), '')
  return columns
}

/** One cell: a missing value is empty, anything structured is JSON. */
export function csvCell(fields: Record<string, unknown>, column: string): string {
  const value = column.split('.').reduce<unknown>((current, segment) => {
    if (current && typeof current === 'object' && !Array.isArray(current))
      return (current as Record<string, unknown>)[segment]
    return undefined
  }, fields)
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** RFC 4180: quote when the text carries a comma, a quote or a newline. */
export function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csvRow(values: readonly string[]): string {
  return `${values.map(csvField).join(',')}\n`
}

/** The name the browser saves the file under. */
export function formatInfo(format: ExportFormat): ExportFormatInfo {
  return EXPORT_FORMATS.find((item) => item.id === format) ?? EXPORT_FORMATS[0]
}

export function exportFilename(
  collectionPath: string,
  format: ExportFormat,
  at = new Date(),
): string {
  const stem = collectionPath.replaceAll('/', '-') || 'firestore'
  const stamp = at.toISOString().slice(0, 19).replaceAll(':', '').replace('T', '-')
  const extension = formatInfo(format).extension
  return `${stem}-${stamp}.${extension}`
}

export interface ExportSource {
  scope: FirestoreScope
  collectionPath: string
  group: boolean
  query: WorkbenchQuery
  /** Export only these document paths; everything matching when empty. */
  only?: readonly string[] | undefined
}

/**
 * Reads the whole result, a page at a time, with the same cursors the grid
 * pages with. Yields each batch so a caller can write it out and report
 * progress rather than holding the whole export in one array.
 */
export async function* exportPages(
  source: ExportSource,
  signal?: AbortSignal,
): AsyncGenerator<FsDocument[]> {
  const only = source.only?.length ? new Set(source.only) : undefined
  const { parent, collectionId } = splitCollection(source.collectionPath, source.group)
  const root = documentRoot(source.scope)
  // The export is not the grid: it reads as much per request as the engine
  // will give, and a limit the person wrote is still theirs to keep.
  const paged: WorkbenchQuery = {
    ...source.query,
    limit: Math.min(source.query.limit, EXPORT_PAGE),
  }
  let remaining = source.query.limit
  let cursor: RestValue[] | undefined
  for (;;) {
    if (signal?.aborted) return
    // Sequential on purpose: each page starts at the cursor the one before
    // it ended on, so there is nothing to run in parallel.
    // oxlint-disable-next-line no-await-in-loop
    const page = await runQuery(
      source.scope,
      parent,
      toStructuredQuery(collectionId, source.group, paged, root, cursor),
    )
    const documents = only
      ? page.documents.filter((document) => only.has(document.path))
      : page.documents
    if (documents.length > 0) yield documents
    remaining -= page.documents.length
    if (page.documents.length < paged.limit || remaining <= 0) return
    const tail = page.documents.at(-1)
    if (!tail) return
    cursor = cursorAfter(tail, source.query, root)
  }
}

/** Hands the finished file to the browser. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  // Revoking immediately can cancel the download in some browsers; a tick
  // later the navigation has already started.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Whether the export dialog is open. Anything can ask for it: the grid's
 *  footer, the selection bar, ⌘K. */
export const useExportDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
  }),
)
