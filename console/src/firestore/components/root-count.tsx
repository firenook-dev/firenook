// A root collection's document count, asked on its own: what the landing's
// cards and the tree show while the schema index is still being built. The
// count is one query per collection, shared by both through the cache.

import { useQuery } from '@tanstack/react-query'
import { EMPTY_QUERY } from '../query'
import { countQueryOptions } from '../queries'
import { formatNumber } from '../value'
import { useWorkbench } from './workbench-context'

export function RootCount({ path }: { path: string }) {
  const workbench = useWorkbench()
  const count = useQuery(countQueryOptions(workbench.ownerScope, path, false, EMPTY_QUERY))
  return (
    <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
      {count.data ? formatNumber(count.data.count) : ''}
    </span>
  )
}
