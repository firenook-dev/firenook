// What the Files route's search middleware needs, kept light: the route's
// search handling loads with the first route (only its component is split
// off), so this module imports neither the page nor the query layer.

import type { StorageBuckets } from '@/api/generated/storage/StorageBuckets'
import { statusQuery } from '@/api/queries'
import { queryClient } from '@/lib/query'
import type { FilesSearch } from './search'

/** `storageKeys.buckets(project)`, spelt here so the first route need not load the query layer. */
export function bucketsKeyOf(project: string): readonly ['storage', string, 'buckets'] {
  return ['storage', project, 'buckets']
}

/** The default bucket, once the buckets have been read. */
function defaultBucket(): string | undefined {
  const project = queryClient.getQueryData(statusQuery.queryKey)?.projectId
  if (project === undefined) return undefined
  return queryClient.getQueryData<StorageBuckets>(bucketsKeyOf(project))?.defaultBucket
}

/**
 * The route's middleware that keeps the default bucket out of the address,
 * as defaults are: a link to `?bucket=<default>` (an `EntityRef` route, a
 * paste) lands on the plain `/storage`.
 */
export function dropDefaultBucket({
  search,
  next,
}: {
  search: FilesSearch
  next: (search: FilesSearch) => FilesSearch
}): FilesSearch {
  const result = next(search)
  if (result.bucket !== undefined && result.bucket === defaultBucket()) {
    const { bucket: _default, ...rest } = result
    return rest
  }
  return result
}
