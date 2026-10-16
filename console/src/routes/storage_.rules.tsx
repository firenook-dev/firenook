import { createFileRoute } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { StorageRulesPage } from '@/storage/rules-page/storage-rules-page'
import { storageRulesSearch } from '@/storage/rules-page/rules-search'

// The Storage rules of a bucket — or of every bucket, when one file governs
// them all — as a page of its own beside Files: the editor, and beside it
// what the rules decided, a playground, saved tests and the folders they
// govern. The trailing underscore keeps it out of the Files page's layout.
export const Route = createFileRoute('/storage_/rules')({
  validateSearch: storageRulesSearch,
  component: StorageRulesRoute,
})

function StorageRulesRoute() {
  return (
    <SectionFrame section="storage">
      <StorageRulesPage />
    </SectionFrame>
  )
}
