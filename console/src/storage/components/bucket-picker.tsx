// The bucket in view, leading the panel: the foundation's scope picker
// ("Bucket demo.appspot.com ▾"), each bucket with its live figures — the
// default one first and marked, then the ones firebase.json names, then any
// other bucket holding objects. A bucket no rules serve says so: every
// client request to it is refused. Opening the list reads the buckets
// again, so one an app created since the page loaded is there.
//
// "Open a bucket by name…" (for one that holds nothing yet) is the panel
// menu's first item rather than this list's last: every item here is a
// bucket name, set in the data face.

import { useQueryClient } from '@tanstack/react-query'
import type { StorageBucket } from '@/api/generated/storage/StorageBucket'
import { ScopeSelect } from '@/components/console/scope-select'
import { formatBytes, formatNumber } from '@/lib/format'
import { useFiles } from '../files-state'
import { storageKeys } from '../queries'

/** `default · 1,204 · 38 MB`, `· 48 MB in flight` while uploads stage bytes; `—` while counting. */
export function bucketFigures(bucket: StorageBucket): string {
  const parts: string[] = []
  if (bucket.isDefault) parts.push('default')
  parts.push(
    bucket.objects === null
      ? '—'
      : `${formatNumber(bucket.objects)} · ${formatBytes(bucket.bytes ?? 0)}`,
  )
  if (bucket.inFlight.bytes > 0) parts.push(`${formatBytes(bucket.inFlight.bytes)} in flight`)
  if (!bucket.served) parts.push('no rules')
  return parts.join(' · ')
}

export function BucketPicker() {
  const files = useFiles()
  const queryClient = useQueryClient()
  return (
    <ScopeSelect
      label="Bucket"
      value={files.bucket}
      items={files.buckets.buckets.map((bucket) => ({
        value: bucket.name,
        detail: bucketFigures(bucket),
      }))}
      onChange={files.setBucket}
      onOpen={() =>
        void queryClient.invalidateQueries({ queryKey: storageKeys.buckets(files.project) })
      }
      testId="bucket-picker"
      className="flex-1"
    />
  )
}
