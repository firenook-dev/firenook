// The tab's upload queue as data: what is queued, sending, done, refused or
// failed, and how far each got. A small store with no query or kit import,
// so the shell's beacon (the nav's "3 uploading" and the leave-page guard)
// can read it from any page without loading the Files page. The work itself
// — bytes, requests, retries — is `uploads.ts`'s.
//
// Memory is bounded: finished items past the last 1,000 are dropped, their
// counts kept in the running totals the tray's header reads.

import { create } from 'zustand'

export type UploadState =
  | 'queued'
  | 'checking'
  | 'uploading'
  | 'done'
  | 'failed'
  | 'refused'
  | 'skipped'
  | 'cancelled'

export interface UploadItem {
  id: string
  bucket: string
  /** The object name it uploads to. */
  name: string
  size: number
  /** Bytes sent so far. */
  loaded: number
  state: UploadState
  /** Why it failed, was refused or skipped, in the engine's words or ours. */
  message?: string | undefined
  /** A refusal: the deciding line, and what the engine said beside it (for See why). */
  line?: number | null | undefined
  refusal?: unknown
  /** Refused by the dry run, before any byte went. */
  notSent?: boolean | undefined
}

/** How many finished items the tray keeps listed. */
export const KEEP_FINISHED = 1_000

/** States that hold, or wait for, a slot. */
const ACTIVE: ReadonlySet<UploadState> = new Set(['queued', 'checking', 'uploading'])

export function isActive(item: Pick<UploadItem, 'state'>): boolean {
  return ACTIVE.has(item.state)
}

export interface QueueTotals {
  /** Files ever added since the queue was last cleared. */
  files: number
  bytes: number
  /** Finished, whatever their outcome, including those no longer listed. */
  finished: number
  /** Bytes of the uploads that completed. */
  sentBytes: number
}

interface QueueState {
  items: readonly UploadItem[]
  totals: QueueTotals
  collapsed: boolean
  /** The tray is shown (it closes when emptied or dismissed). */
  open: boolean
  add: (items: readonly UploadItem[]) => void
  patch: (id: string, patch: Partial<UploadItem>) => void
  setCollapsed: (collapsed: boolean) => void
  /** Drops every finished item; active ones stay. */
  clearFinished: () => void
  close: () => void
}

const EMPTY_TOTALS: QueueTotals = { files: 0, bytes: 0, finished: 0, sentBytes: 0 }

/** `items` with finished ones past the last `keep` dropped. */
export function pruneFinished(items: readonly UploadItem[], keep = KEEP_FINISHED): UploadItem[] {
  let finished = 0
  for (const item of items) if (!isActive(item)) finished += 1
  let drop = Math.max(0, finished - keep)
  if (drop === 0) return [...items]
  return items.filter((item) => {
    if (drop > 0 && !isActive(item)) {
      drop -= 1
      return false
    }
    return true
  })
}

export const useUploadQueue = create<QueueState>((set) => ({
  items: [],
  totals: EMPTY_TOTALS,
  collapsed: false,
  open: false,
  add: (added) =>
    set((state) => ({
      items: pruneFinished([...state.items, ...added]),
      totals: {
        ...state.totals,
        files: state.totals.files + added.length,
        bytes: state.totals.bytes + added.reduce((sum, item) => sum + item.size, 0),
        finished: state.totals.finished + added.filter((item) => !isActive(item)).length,
      },
      open: true,
      collapsed: false,
    })),
  patch: (id, patch) =>
    set((state) => {
      const at = state.items.findIndex((item) => item.id === id)
      const before = state.items[at]
      if (!before) return state
      const after = { ...before, ...patch }
      const items = [...state.items]
      items[at] = after
      const ended = isActive(before) && !isActive(after)
      const restarted = !isActive(before) && isActive(after)
      return {
        items: ended ? pruneFinished(items) : items,
        totals: {
          ...state.totals,
          finished: state.totals.finished + (ended ? 1 : restarted ? -1 : 0),
          sentBytes:
            state.totals.sentBytes +
            (after.state === 'done' && before.state !== 'done' ? after.size : 0),
        },
      }
    }),
  setCollapsed: (collapsed) => set({ collapsed }),
  clearFinished: () =>
    set((state) => {
      const items = state.items.filter(isActive)
      return items.length === 0
        ? { items, totals: EMPTY_TOTALS, open: false }
        : {
            items,
            totals: {
              files: items.length,
              bytes: items.reduce((sum, item) => sum + item.size, 0),
              finished: 0,
              sentBytes: 0,
            },
          }
    }),
  close: () =>
    set((state) =>
      state.items.some(isActive)
        ? { collapsed: true }
        : { open: false, items: [], totals: EMPTY_TOTALS },
    ),
}))

/** What is in flight: uploads queued, being checked or sending, and their bytes. */
export function inFlight(items: readonly UploadItem[]): {
  count: number
  bytes: number
  loaded: number
} {
  let count = 0
  let bytes = 0
  let loaded = 0
  for (const item of items) {
    if (!isActive(item)) continue
    count += 1
    bytes += item.size
    loaded += item.loaded
  }
  return { count, bytes, loaded }
}
