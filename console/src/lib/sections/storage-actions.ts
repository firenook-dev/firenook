// What ⌘K offers from anywhere for Storage. Only the palette reads it
// (`lib/palette-actions.ts`), so these icons stay off the first route.

import { FolderPlusIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import type { SectionAction } from '../services'

export const storageActions: readonly SectionAction[] = [
  {
    id: 'storage.upload',
    title: 'Upload files',
    keywords: 'storage bucket object',
    icon: UploadSimpleIcon,
    link: { to: '/storage', search: { new: 'upload' } },
  },
  {
    id: 'storage.folder',
    title: 'Create a folder',
    keywords: 'storage bucket',
    icon: FolderPlusIcon,
    link: { to: '/storage', search: { new: 'folder' } },
  },
]
