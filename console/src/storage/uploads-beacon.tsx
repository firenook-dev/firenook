// What the console keeps alive while this tab uploads, on every page: the
// Storage nav item's "3 uploading" (a tab-local badge) and the browser's
// leave-page question while bytes are in flight. The shell mounts it while
// Storage is ready (the registry's `shellMount`), as its own small chunk: it
// imports the upload queue's store and nothing else of the section.

import { useEffect } from 'react'
import { useLocalBadge } from '@/lib/badges'
import { inFlight, useUploadQueue } from './upload-queue-store'

export const UPLOADS_BADGE = 'storage.uploads'

export default function UploadsBeacon() {
  const active = useUploadQueue((state) => inFlight(state.items).count)
  useLocalBadge(
    UPLOADS_BADGE,
    active > 0
      ? {
          count: active,
          tone: 'neutral',
          noun: { one: 'upload in progress', other: 'uploads in progress' },
        }
      : undefined,
  )
  const sending = active > 0
  useEffect(() => {
    if (!sending) return undefined
    // Closing or reloading the tab would drop the uploads still sending.
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [sending])
  return null
}
