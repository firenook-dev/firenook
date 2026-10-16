import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { SectionFrame } from '@/components/console/section-gate'
import { StoragePage } from '@/storage/components/storage-page'
import { dropDefaultBucket } from '@/storage/route-search'
import { FILES_DEFAULTS, filesSearch } from '@/storage/search'

// Every view of the Files page is a link: the bucket, the folder, the open
// object and its tab, the layout, the order, the filter, the scope, who it
// acts as and an open dialog. Defaults never reach the address, and nor
// does the default bucket — only the bucket list knows which that is.
export const Route = createFileRoute('/storage')({
  validateSearch: filesSearch,
  search: { middlewares: [stripSearchParams(FILES_DEFAULTS), dropDefaultBucket] },
  component: () => (
    <SectionFrame section="storage" projectScope={false}>
      <StoragePage />
    </SectionFrame>
  ),
})
