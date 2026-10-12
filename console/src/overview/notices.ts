// Which of the engine's configuration notices this browser has dismissed
// (`OverviewState.notices`: a non-demo project, a public listen address,
// emulators missing while Functions run, diagnostics off). A dismissal is
// kept per notice code and per engine instance in localStorage, under
// `firenook.console.notice.<code>.<instance>`: every tab agrees at once
// (the `storage` event), and a new engine run shows the notice again,
// because the configuration it warns about may have changed. A browser
// that refuses storage keeps the dismissal for this tab, and a notice it
// cannot read the record of is shown.

import { useCallback, useSyncExternalStore } from 'react'
import type { OverviewNotice } from '@/api/generated/observe/OverviewNotice'

const PREFIX = 'firenook.console.notice.'

/** Where one dismissal is kept. */
export function noticeKey(code: string, instance: string): string {
  return `${PREFIX}${code}.${instance}`
}

export interface NoticeStore {
  isDismissed(code: string, instance: string): boolean
  dismiss(code: string, instance: string): void
  /** Called when this tab or another one dismisses a notice. */
  subscribe(listener: () => void): () => void
  /** Moves on every change, for `useSyncExternalStore`. */
  version(): number
}

/**
 * A store over `storage`, told about other tabs' dismissals through
 * `events`' `storage` event. Reads go to storage every time (there are a
 * handful of notices), so a second store over the same storage agrees.
 */
export function createNoticeStore(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  events?: Pick<Window, 'addEventListener'>,
): NoticeStore {
  // Dismissals storage refused, for this tab only.
  const local = new Set<string>()
  const listeners = new Set<() => void>()
  let version = 0
  const changed = () => {
    version += 1
    for (const listener of listeners) listener()
  }
  events?.addEventListener('storage', (event) => {
    if (event.key === null || event.key.startsWith(PREFIX)) changed()
  })
  return {
    isDismissed(code, instance) {
      const key = noticeKey(code, instance)
      if (local.has(key)) return true
      try {
        return storage?.getItem(key) === '1'
      } catch {
        // Unreadable storage: the notice is shown.
        return false
      }
    },
    dismiss(code, instance) {
      const key = noticeKey(code, instance)
      try {
        if (!storage) throw new Error('no storage')
        storage.setItem(key, '1')
      } catch {
        local.add(key)
      }
      changed()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => version,
  }
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    // A sandboxed page may throw on the property itself.
    return undefined
  }
}

/** This browser's store. */
export const noticeStore: NoticeStore = createNoticeStore(
  browserStorage(),
  typeof window === 'undefined' ? undefined : window,
)

/** The notices this browser has not dismissed for this engine run, in the engine's order. */
export function visibleNotices(
  notices: readonly OverviewNotice[],
  instance: string,
  store: NoticeStore = noticeStore,
): OverviewNotice[] {
  return notices.filter((notice) => !store.isDismissed(notice.code, instance))
}

/**
 * The Overview's notices for engine run `instance`, without the dismissed
 * ones, and a way to dismiss one; follows other tabs.
 */
export function useNotices(
  notices: readonly OverviewNotice[],
  instance: string,
  store: NoticeStore = noticeStore,
): { visible: OverviewNotice[]; dismiss: (code: string) => void } {
  // The version is an input of the filter, so a compiled component works it
  // out again when this tab or another dismisses a notice.
  const version = useSyncExternalStore(store.subscribe, store.version)
  const dismiss = useCallback((code: string) => store.dismiss(code, instance), [store, instance])
  return { visible: noticesAt(version, notices, instance, store), dismiss }
}

function noticesAt(
  _version: number,
  notices: readonly OverviewNotice[],
  instance: string,
  store: NoticeStore,
): OverviewNotice[] {
  return visibleNotices(notices, instance, store)
}
