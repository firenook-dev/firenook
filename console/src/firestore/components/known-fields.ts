// The shape a collection has in practice. Firestore has no schema, but the
// documents on screen agree about most of their fields, and a console that
// has already worked that out for the grid's columns should not make anyone
// retype a field name it knows — nor guess the type it is usually given.
//
// It reads the grid's own page query, so this costs nothing: same key, same
// cache, no second request. Outside that collection — a reference peeked
// into from somewhere else — there is nothing loaded to learn from and the
// list is honestly empty.

import { useInfiniteQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { inferColumns } from '../columns'
import { pageQueryOptions } from '../queries'
import type { KnownField } from './field-context'
import { useWorkbench } from './workbench-context'

export function useKnownFields(collection: string): KnownField[] {
  const workbench = useWorkbench()
  const same = collection !== '' && collection === workbench.collectionPath
  const page = useInfiniteQuery({
    ...pageQueryOptions(
      workbench.scope,
      workbench.collectionPath,
      workbench.group,
      workbench.query,
    ),
    enabled: same,
  })
  const pages = page.data?.pages
  return useMemo(() => {
    if (!same || !pages) return []
    return inferColumns(pages.flatMap((item) => item.documents)).map((column) => ({
      field: column.field,
      type: column.type,
      present: column.present,
    }))
  }, [same, pages])
}
