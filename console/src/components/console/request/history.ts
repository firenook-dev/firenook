// The requests a composer sent, newest first, so the last few can be sent
// again or edited: 25 per composer and project, in this browser. A body
// over 64 KB is not kept (the entry says how large it was), and a browser
// that refuses the write — a full quota, storage switched off — keeps the
// history in memory for the session instead of failing the send.

import { useCallback, useSyncExternalStore } from 'react'
import { formatBytes } from '@/lib/format'
import { useConsoleProject } from '@/lib/project'
import type { ComposedRequest } from './types'

/** Requests kept per composer and project. */
export const HISTORY_LIMIT = 25
/** The largest body kept, in UTF-8 bytes. */
export const HISTORY_BODY_LIMIT = 64 * 1024

export interface HistoryEntry extends ComposedRequest {
  /** When it was sent, RFC 3339. */
  sentAt: string
  /** The body was too large to keep; its size, as the console writes sizes ("2.1 MB"). */
  bodyOmitted?: string
}

const PREFIX = 'firenook.console.requests'

/** The entry as it is kept: a large body left out, everything else as sent. */
export function toEntry(request: ComposedRequest, sentAt: string): HistoryEntry {
  const size = new TextEncoder().encode(request.body.text).length
  if (size <= HISTORY_BODY_LIMIT) return { ...request, sentAt }
  return {
    ...request,
    body: { kind: request.body.kind, text: '' },
    sentAt,
    bodyOmitted: formatBytes(size),
  }
}

/** Two requests are the same entry when they would send the same thing as the same identity. */
function sameRequest(a: ComposedRequest, b: ComposedRequest): boolean {
  return (
    JSON.stringify([a.method, a.url, a.query, a.headers, a.body, a.identity]) ===
    JSON.stringify([b.method, b.url, b.query, b.headers, b.body, b.identity])
  )
}

export interface RequestHistoryStore {
  entries(slot: string): readonly HistoryEntry[]
  push(slot: string, request: ComposedRequest): void
  clear(slot: string): void
  subscribe(listener: () => void): () => void
}

const NONE: readonly HistoryEntry[] = []

/** A history over `storage` (undefined, or one that throws, keeps it in memory). */
export function createRequestHistory(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined,
): RequestHistoryStore {
  const memory = new Map<string, readonly HistoryEntry[]>()
  const listeners = new Set<() => void>()
  const read = (slot: string): readonly HistoryEntry[] => {
    const known = memory.get(slot)
    if (known) return known
    let loaded: readonly HistoryEntry[] = NONE
    try {
      const text = storage?.getItem(`${PREFIX}.${slot}`)
      const parsed: unknown = text ? JSON.parse(text) : undefined
      if (Array.isArray(parsed)) loaded = (parsed as HistoryEntry[]).slice(0, HISTORY_LIMIT)
    } catch {
      // Unreadable or refused: an empty history, not a broken composer.
    }
    memory.set(slot, loaded)
    return loaded
  }
  const write = (slot: string, entries: readonly HistoryEntry[]) => {
    memory.set(slot, entries)
    try {
      if (entries.length === 0) storage?.removeItem(`${PREFIX}.${slot}`)
      else storage?.setItem(`${PREFIX}.${slot}`, JSON.stringify(entries))
    } catch {
      // A full quota or storage switched off: the history lives on in
      // memory for this session.
    }
    for (const listener of listeners) listener()
  }
  return {
    entries: read,
    push(slot, request) {
      const entry = toEntry(request, new Date().toISOString())
      const rest = read(slot).filter((known) => !sameRequest(known, entry))
      write(slot, [entry, ...rest].slice(0, HISTORY_LIMIT))
    },
    clear: (slot) => write(slot, NONE),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

const shared = createRequestHistory(browserStorage())

/** The history of composer `key` (`functions.invoke`, `tasks.enqueue`…) for the page's project. */
export function useRequestHistory(key: string): {
  entries: readonly HistoryEntry[]
  push: (request: ComposedRequest) => void
  clear: () => void
} {
  const { project } = useConsoleProject()
  const slot = `${project}.${key}`
  const entries = useSyncExternalStore(
    shared.subscribe,
    () => shared.entries(slot),
    () => shared.entries(slot),
  )
  const push = useCallback((request: ComposedRequest) => shared.push(slot, request), [slot])
  const clear = useCallback(() => shared.clear(slot), [slot])
  return { entries, push, clear }
}
