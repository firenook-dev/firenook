// "Paused · 12 new" for a list seeded from the engine's first page after it
// mounts. A list opened paused (its address says `paused=true`) holds still
// from its first page on: the page it was opened on is what it shows, and
// only what arrives after it counts as new. Asked before the page is in,
// the kit's count would take every seeded row for news ("Paused · 200
// new" on a reload), so the pause starts counting once the page is in.

import { useFeedPending } from '@/components/console/feed-list'
import { type FeedStore, useFeed } from '@/lib/live/feed-store'

/**
 * What arrived while paused, counted from the seeded page: `total` is the
 * first page's answer for the list (undefined until it is in).
 */
export function useSeededPending<T>(
  store: FeedStore<T>,
  paused: boolean,
  rowKey: (item: T) => string,
  total: number | undefined,
): number {
  'use no memo'
  const figures = useFeed(store)
  const seeded = total !== undefined && (figures.size > 0 || total === 0)
  return useFeedPending(store, paused && seeded, rowKey)
}
