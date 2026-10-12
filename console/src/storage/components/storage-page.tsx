// The Files page: one workbench over the bucket in view, filling the content
// column edge to edge. The page reads the buckets first — which one is the
// default, which rules mode governs them — because every query below is
// keyed by the bucket; until they arrive it holds still (after 150 ms, a
// quiet line) rather than drawing a toolbar that would move.

import { Text } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { statusQuery } from '@/api/queries'
import { useDelayedFlag } from '@/components/console/empty-state'
import { SectionPage } from '@/components/console/section-page'
import { Page } from '@/components/shell/page'
import { storage } from '@/lib/sections/storage'
import { FilesProvider, useFilesStateValue } from '../files-state'
import UploadsBeacon from '../uploads-beacon'
import { FilesWorkbench } from './files-workbench'

export function StoragePage() {
  const files = useFilesStateValue()
  const status = useQuery(statusQuery)
  const waiting = useDelayedFlag(files === undefined)
  return (
    <SectionPage section="storage" page="files" title="Storage" testId="storage-page">
      {/* While the section is unbuilt the shell does not mount its beacon,
          so the page keeps the uploads badge and the leave-page guard itself. */}
      {!storage.built && <UploadsBeacon />}
      {files ? (
        <FilesProvider value={files}>
          <FilesWorkbench />
        </FilesProvider>
      ) : waiting ? (
        <Page>
          <Text variant="secondary">
            {status.isError ? 'The engine is unreachable.' : 'Reading the buckets…'}
          </Text>
        </Page>
      ) : null}
    </SectionPage>
  )
}
