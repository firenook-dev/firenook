import { afterEach, describe, expect, it } from 'vitest'
import { statusQuery } from '@/api/queries'
import { queryClient } from '@/lib/query'
import { storageKeys } from './queries'
import { bucketsKeyOf, dropDefaultBucket } from './route-search'
import type { FilesSearch } from './search'

const next = (search: FilesSearch) => search
const search = (value: Partial<FilesSearch>) => value as FilesSearch

afterEach(() => queryClient.clear())

describe('the Files route’s search', () => {
  it('spells the buckets key as the query layer does', () => {
    expect(bucketsKeyOf('demo')).toEqual(storageKeys.buckets('demo'))
  })

  it('drops the default bucket once the buckets are known, and keeps any other', () => {
    expect(dropDefaultBucket({ search: search({ bucket: 'demo.appspot.com' }), next })).toEqual({
      bucket: 'demo.appspot.com',
    })
    queryClient.setQueryData(statusQuery.queryKey, { projectId: 'demo' } as never)
    queryClient.setQueryData(storageKeys.buckets('demo'), {
      defaultBucket: 'demo.appspot.com',
      rulesMode: 'perBucket',
      buckets: [],
      indexReady: true,
    })
    expect(
      dropDefaultBucket({ search: search({ bucket: 'demo.appspot.com', path: 'a/' }), next }),
    ).toEqual({
      path: 'a/',
    })
    expect(dropDefaultBucket({ search: search({ bucket: 'demo-media' }), next })).toEqual({
      bucket: 'demo-media',
    })
  })
})
