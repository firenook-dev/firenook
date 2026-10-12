// Resumable uploads an app started and has not finished, as the
// "Uploads in progress" list writes them.

import type { StorageUploadSession } from '@/api/generated/storage/StorageUploadSession'
import { formatBytes, relativeTime } from '@/lib/format'

/** `48 MB of 210 MB`, or `48 MB received` when the app declared no size. */
export function sessionProgress(session: Pick<StorageUploadSession, 'received' | 'total'>): string {
  return session.total === null
    ? `${formatBytes(session.received)} received`
    : `${formatBytes(session.received)} of ${formatBytes(session.total)}`
}

/** `idle 3 h`, from the last time the session moved. */
export function sessionIdle(
  session: Pick<StorageUploadSession, 'updatedAt' | 'startedAt'>,
  now = Date.now(),
): string | undefined {
  const at = session.updatedAt ?? session.startedAt
  if (!at) return undefined
  const ago = relativeTime(at, now)
  return ago === 'just now' ? 'active just now' : `idle ${ago.replace(/ ago$/, '')}`
}

/** Who started it: Admin, a uid, or an unauthenticated client. */
export function sessionOwner(session: Pick<StorageUploadSession, 'uid' | 'admin'>): string {
  if (session.admin) return 'Admin'
  return session.uid ?? 'anonymous'
}
