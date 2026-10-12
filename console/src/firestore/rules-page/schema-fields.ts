// What the documents of a collection pattern hold, sampled from the data:
// the field names the editor offers after `resource.data.`, and the types a
// starter rule checks them against. Only an emulator's console can know
// these — the rules language itself knows nothing of your schema.

import { queryOptions } from '@tanstack/react-query'
import { inferColumns } from '../columns'
import { EMPTY_QUERY, toStructuredQuery } from '../query'
import { FS } from '../queries'
import { documentRoot, firestoreScope, runQuery } from '../rest'
import type { FirestoreValueType, FsDocument } from '../value'

export interface FieldSample {
  /** A top-level field, or `map.key` one level into a map. */
  field: string
  type: FirestoreValueType
  /** Documents of the sample that carry it, of `of`. */
  present: number
  of: number
}

/** Documents a sample reads; enough to see the shape, few enough to be instant. */
const SAMPLE = 100

/** Whether a document path is a document of the pattern (`users/*\/orders`). */
export function inPattern(path: string, pattern: string): boolean {
  const segments = path.split('/')
  const parts = pattern.split('/')
  if (segments.length !== parts.length + 1) return false
  return parts.every((part, index) => part === '*' || part === segments[index])
}

/** Field names and types across the sampled documents, maps opened one level. */
export function sampleFields(documents: readonly FsDocument[]): FieldSample[] {
  const columns = inferColumns(documents)
  const out: FieldSample[] = columns.map((column) => ({
    field: column.field,
    type: column.type,
    present: column.present,
    of: column.of,
  }))
  for (const column of columns) {
    if (column.type !== 'map') continue
    const nested = documents.flatMap((document) => {
      const value = document.fields[column.field]
      return value?.type === 'map'
        ? [{ ...document, fields: value.fields } satisfies FsDocument]
        : []
    })
    for (const inner of inferColumns(nested))
      out.push({
        field: `${column.field}.${inner.field}`,
        type: inner.type,
        present: inner.present,
        of: column.of,
      })
  }
  return out
}

export const fieldsQuery = (project: string, database: string, pattern: string) =>
  queryOptions({
    queryKey: [FS, database, 'rules-fields', pattern],
    queryFn: async (): Promise<FieldSample[]> => {
      const scope = firestoreScope({ project, database, identity: { kind: 'owner' } })
      const id = pattern.slice(pattern.lastIndexOf('/') + 1)
      // Read as the owner: the shape of the data is not a question of
      // who may read it.
      const page = await runQuery(
        scope,
        '',
        toStructuredQuery(id, true, { ...EMPTY_QUERY, limit: SAMPLE }, documentRoot(scope)),
      )
      return sampleFields(page.documents.filter((document) => inPattern(document.path, pattern)))
    },
    staleTime: 60_000,
    retry: false,
  })
