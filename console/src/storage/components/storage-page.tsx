// The Files page: one workbench over the bucket in view, filling the content
// column edge to edge. The page reads the buckets first — which one is the
// default, which rules mode governs them — because every query below is
// keyed by the bucket. Until they arrive it draws the workbench's frame —
// the panel, both toolbar rows — with the list's skeleton where the files
// will be, so nothing moves when they land and the page waits the way
// every other table does.

import { Text } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { statusQuery } from '@/api/queries'
import { TableSkeleton } from '@/components/console/empty-state'
import { PanelHeader } from '@/components/console/panel'
import { SectionBody, SectionPage } from '@/components/console/section-page'
import { SectionToolbar, ToolbarRow } from '@/components/console/toolbar'
import { PanelToggle, SectionPanel } from '@/components/shell/section-panel'
import { FilesProvider, useFilesStateValue } from '../files-state'
import { FilesWorkbench } from './files-workbench'

/** The list's columns while the buckets are on their way: name, size, type, updated. */
const FILES_SKELETON = [{ width: 320 }, { width: 96 }, { width: 140 }, { width: 160 }]

export function StoragePage() {
  const files = useFilesStateValue()
  return (
    <SectionPage section="storage" page="files" title="Storage" testId="storage-page">
      {files ? (
        <FilesProvider value={files}>
          <FilesWorkbench />
        </FilesProvider>
      ) : (
        <FilesFrame />
      )}
    </SectionPage>
  )
}

/** The workbench's frame while the buckets load: the same rows, empty, and the list's skeleton. */
function FilesFrame() {
  const status = useQuery(statusQuery)
  return (
    <>
      <SectionPanel label="Folders">
        <PanelHeader>
          <span className="truncate text-[12px] text-kumo-subtle">Folders</span>
        </PanelHeader>
      </SectionPanel>
      <SectionToolbar>
        <ToolbarRow testId="storage-toolbar-loading">
          <PanelToggle where="toolbar" />
        </ToolbarRow>
        <ToolbarRow variant="line">
          <span className="h-8" aria-hidden />
        </ToolbarRow>
      </SectionToolbar>
      <SectionBody>
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          aria-busy
          data-testid="storage-loading"
        >
          {status.isError ? (
            <div className="flex h-40 items-center justify-center">
              <Text variant="secondary">The engine is unreachable.</Text>
            </div>
          ) : (
            <TableSkeleton columns={FILES_SKELETON} />
          )}
        </div>
      </SectionBody>
    </>
  )
}
