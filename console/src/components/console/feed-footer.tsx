// A feed's status bar: what is loaded, and how much the engine keeps — so
// "1,532 loaded" never reads as everything there ever was. The table
// footer's shape (`TableFooter`): one 36 px row, nothing wraps.

import { Text } from '@cloudflare/kumo'
import { formatNumber } from '@/lib/format'
import { type FeedStore, useFeed } from '@/lib/live/feed-store'

/** The rows of a store that are items (not a gap or a marker). */
export function useItemCount<T>(store: FeedStore<T>): number {
  // It walks the mutable store while rendering: the compiler would keep the
  // first answer for as long as the store is the same object.
  'use no memo'
  useFeed(store)
  let count = 0
  for (let index = 0; index < store.size(); index += 1)
    if (store.at(index)?.kind === 'item') count += 1
  return count
}

/** "86 loaded · the engine keeps the newest 2,000 messages". */
export function feedFooterText(
  loaded: number,
  capacity: number,
  noun: { one: string; other: string },
): string {
  return `${formatNumber(loaded)} loaded · the engine keeps the newest ${formatNumber(capacity)} ${capacity === 1 ? noun.one : noun.other}`
}

export function FeedFooter({
  loaded,
  capacity,
  noun,
  testId,
}: {
  loaded: number
  capacity: number
  noun: { one: string; other: string }
  testId?: string
}) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-t border-kumo-line px-3 whitespace-nowrap"
      role="status"
      aria-label={`Loaded ${noun.other}`}
      data-testid={testId}
    >
      <Text variant="secondary" size="sm" as="span" DANGEROUS_className="tabular-nums">
        {feedFooterText(loaded, capacity, noun)}
      </Text>
    </div>
  )
}
