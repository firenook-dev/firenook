// Storage's bulk work under the toolbar, on the console's one job banner
// (`SectionJobs`): each job's title ("Delete users/ · 900 files · 20 MB"),
// how far it got, Cancel, and once it ends a few seconds of what it did —
// a refused item explained by its rules decision ("Why"). A reloaded page
// finds its running and recent jobs again (`GET /jobs?section=storage`).

import { Button } from '@cloudflare/kumo'
import { useQueryClient } from '@tanstack/react-query'
import type { StorageBulkItemError } from '@/api/generated/storage/StorageBulkItemError'
import { SectionJobs } from '@/components/console/section-jobs'
import type { JobError } from '@/lib/jobs'
import { useFiles } from '../files-state'
import { storageKeys } from '../queries'
import { RefusalDetail } from './refusal-detail'

/** The verb a job's progress says, by its kind. */
export function jobVerb(kind: string): string {
  if (kind === 'storage.move') return 'moved'
  if (kind === 'storage.copy') return 'copied'
  if (kind === 'storage.metadata') return 'changed'
  return 'deleted'
}

/** Why one item was refused: its rules decision, explained, when the rules refused it. */
function why(error: JobError) {
  const detail = error.detail as StorageBulkItemError | undefined
  if (!detail?.evaluation) return null
  return (
    <RefusalDetail
      extras={{
        decision: detail.decision,
        evaluation: detail.evaluation,
        request: detail.request,
      }}
      trigger={
        <Button variant="ghost" size="xs">
          Why
        </Button>
      }
    />
  )
}

export function StorageJobs() {
  const files = useFiles()
  const queryClient = useQueryClient()
  return (
    <SectionJobs
      section="storage"
      verb={jobVerb}
      why={why}
      // Once a job ends, the figures and the tree of the bucket are read
      // again: the object changes already refreshed them; this is the backstop.
      onEnded={() => {
        void queryClient.invalidateQueries({
          queryKey: storageKeys.foldersOf(files.project, files.bucket),
        })
        void queryClient.invalidateQueries({
          queryKey: storageKeys.treeOf(files.project, files.bucket),
        })
        void queryClient.invalidateQueries({ queryKey: storageKeys.buckets(files.project) })
      }}
      testId="storage-job"
    />
  )
}
