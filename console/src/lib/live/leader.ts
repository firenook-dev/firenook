// Who in this browser holds the live channel, and how the other tabs talk to
// it. The console is served over HTTP/1.1, where a browser gives one address
// six connections for every tab and every request together, and a stream
// holds one for as long as it is open. So one tab — the leader — owns the
// browser's only `EventSource`; the others hand it their subscriptions and
// receive their events over a `BroadcastChannel`.
//
// The election is Web Locks. Every tab holds `firenook.console.tab.<id>`
// while it lives, so the leader can tell a tab that closed or crashed (its
// lock comes free) from one that is merely quiet. A visible tab with
// subscriptions requests `firenook.console.live`: the holder leads, the rest
// wait in the lock's queue, and when the leader lets go — or crashes, which
// releases its locks with it — the next in the queue is granted at once.
// Without Web Locks or `BroadcastChannel` every tab leads itself.

import type { ApiErrorDetail } from '@/api/generated/ApiErrorDetail'

/** The leader's lock; its holder owns the `EventSource`. */
export const LEADER_LOCK = 'firenook.console.live'
/** Held by every tab for as long as it is open. */
export const TAB_LOCK_PREFIX = 'firenook.console.tab.'
/** The relay between the tabs of one browser. */
export const RELAY_CHANNEL = 'firenook.console.live'

/** The channel's state, as the leader sees it and every tab shows it. */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'paused' | 'too-many'

/** What the engine's `hello` says that every tab compares for itself. */
export interface HelloFacts {
  instance: string
  consoleBuild: string
  engineRevision: string | null
}

/**
 * Messages on the relay. Subscription ids in them are tab subscriptions
 * (`<tab>.s<n>`); the leader maps them onto its engine subscriptions.
 */
export type RelayMessage =
  /** follower → leader: add one subscription; `after` resumes from a cursor. */
  | {
      t: 'sub'
      tab: string
      id: string
      topic: string
      params: Record<string, unknown>
      after?: string
    }
  /** follower → leader: remove one. */
  | { t: 'unsub'; tab: string; id: string }
  /** any → leader: announce yourself. */
  | { t: 'who'; tab: string }
  /** leader → all: the channel is open; re-send your subscriptions. */
  | ({ t: 'hello'; leader: string } & HelloFacts)
  /** leader → all: one engine message, as the engine wrote it, for `subs`. */
  | { t: 'ev'; kind: 'ev' | 'reset' | 'end'; raw: string; subs: string[] }
  /** leader → all: the engine took these subscriptions. */
  | { t: 'accepted'; subs: string[] }
  /** leader → all: the engine would not open these subscriptions. */
  | { t: 'refused'; subs: string[]; error: ApiErrorDetail }
  /** leader → all: the channel's state. */
  | { t: 'status'; leader: string; status: LiveStatus }
  /** leader → all: the engine said it is stopping. */
  | { t: 'stopping'; leader: string }
  /** leader → all: the leader is letting go of the channel. */
  | { t: 'bye'; leader: string }

/** What the election uses of the Web Locks API. */
export interface LockManagerLike {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void> | void,
  ): Promise<unknown>
}

/** What the relay uses of `BroadcastChannel`. */
export interface RelayChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  close(): void
}

export interface ElectionCallbacks {
  /** This tab now holds the leader lock. */
  onLead(): void
  onMessage(message: RelayMessage): void
  /** A tab the leader watched closed or crashed: its subscriptions go. */
  onTabGone(tab: string): void
}

export interface Election {
  readonly tab: string
  /** Whether tabs share one leader; false means every tab leads itself. */
  readonly shared: boolean
  /** Resolves once this tab holds its own tab lock. */
  readonly ready: Promise<void>
  /** Asks to lead: granted now, or queued behind the current leader. */
  want(): void
  /** Takes the request back, or lets go of the lead. */
  withdraw(): void
  isLeader(): boolean
  isWanting(): boolean
  send(message: RelayMessage): void
  /** Leader only: tells `onTabGone` when `tab`'s lock comes free. */
  watch(tab: string): void
  close(): void
}

export function createElection(
  environment: { locks?: LockManagerLike | undefined; relay?: RelayChannelLike | undefined },
  tab: string,
  callbacks: ElectionCallbacks,
): Election {
  const { locks, relay } = environment
  const shared = Boolean(locks && relay)
  let leader = false
  let wanting = false
  let closed = false
  let pending: AbortController | undefined
  let release: (() => void) | undefined
  let watches = new AbortController()
  const watched = new Set<string>()
  let releaseTab: (() => void) | undefined
  const onRelay = (event: MessageEvent) => {
    if (!closed) callbacks.onMessage(event.data as RelayMessage)
  }

  let ready: Promise<void> = Promise.resolve()
  if (shared && locks && relay) {
    ready = new Promise<void>((resolve) => {
      // Held until the page goes: a closed or crashed tab releases it, and
      // that is how the leader learns of it.
      void locks.request(`${TAB_LOCK_PREFIX}${tab}`, {}, () => {
        resolve()
        return new Promise<void>((done) => {
          releaseTab = done
        })
      })
    })
    relay.addEventListener('message', onRelay)
  }

  const stopWatching = () => {
    watches.abort()
    watches = new AbortController()
    watched.clear()
  }

  function withdraw() {
    if (!wanting) return
    wanting = false
    pending?.abort()
    pending = undefined
    if (leader) {
      leader = false
      release?.()
      release = undefined
      stopWatching()
    }
  }

  return {
    tab,
    shared,
    ready,
    want() {
      if (wanting || closed) return
      wanting = true
      if (!shared || !locks) {
        queueMicrotask(() => {
          if (!wanting || leader || closed) return
          leader = true
          callbacks.onLead()
        })
        return
      }
      const controller = new AbortController()
      pending = controller
      locks
        .request(LEADER_LOCK, { signal: controller.signal }, () => {
          // Granted after the tab stopped wanting it: hand it straight on.
          if (controller.signal.aborted || !wanting || closed) return undefined
          pending = undefined
          leader = true
          return new Promise<void>((resolve) => {
            release = resolve
            callbacks.onLead()
          })
        })
        .catch(() => {
          // Aborted while queued: the tab no longer wants to lead.
        })
    },
    withdraw,
    isLeader: () => leader,
    isWanting: () => wanting,
    send(message) {
      // A BroadcastChannel reaches this origin's own tabs only; it takes no target origin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      if (shared && relay && !closed) relay.postMessage(message)
    },
    watch(other) {
      if (!shared || !locks || !leader || other === tab || watched.has(other)) return
      watched.add(other)
      const signal = watches.signal
      locks
        .request(`${TAB_LOCK_PREFIX}${other}`, { signal }, () => {
          watched.delete(other)
          if (leader && !signal.aborted) callbacks.onTabGone(other)
        })
        .catch(() => {
          // The leader stopped leading; somebody else watches now.
        })
    },
    close() {
      withdraw()
      closed = true
      stopWatching()
      releaseTab?.()
      if (relay) {
        relay.removeEventListener('message', onRelay)
        relay.close()
      }
    },
  }
}
