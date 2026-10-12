// Authentication on the console's one live channel: its five topics, and the
// hooks the pages subscribe through. Auth opens no stream of its own, and a
// page subscribes only to what it shows, while it is mounted.
//
// - `auth.users` (invalidation): windows of keys — `{ tenant, changes:
//   [{ uid, change, fields }] }`, coalesced in the engine, a token refresh
//   never sent. The users page hands the uids to `useCursorRows.applyKeys`
//   (one `POST /users:batchGet` patches rows and brings the count and the
//   facets); `readUsersWindow` says what else a window means.
// - `auth.activity`, `auth.inbox` (feeds on the engine's rings, filtered by
//   the engine with the page's `q`): `useActivityFeed` and `useInboxFeed`
//   read the first page, subscribe after its `liveAfter`, push each batch
//   into a bounded feed store, page older history on demand and say a gap.
// - `auth.config`, `auth.hooks` (invalidation): tenants created, changed or
//   deleted, project switches; which blocking functions run.
//
// The engine also sends `tick`s (a cursor and no data) on the feeds; the
// channel consumes them and calls no handler.

import { type QueryKey, hashKey, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AuthActivityBatch } from '@/api/generated/auth/AuthActivityBatch'
import type { AuthActivityFacets } from '@/api/generated/auth/AuthActivityFacets'
import type { AuthActivityPage } from '@/api/generated/auth/AuthActivityPage'
import type { AuthActivityParams } from '@/api/generated/auth/AuthActivityParams'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import type { AuthConfigChanged } from '@/api/generated/auth/AuthConfigChanged'
import type { AuthConfigParams } from '@/api/generated/auth/AuthConfigParams'
import type { AuthInboxBatch } from '@/api/generated/auth/AuthInboxBatch'
import type { AuthInboxParams } from '@/api/generated/auth/AuthInboxParams'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import type { AuthMessageFacets } from '@/api/generated/auth/AuthMessageFacets'
import type { AuthMessagePage } from '@/api/generated/auth/AuthMessagePage'
import type { AuthUsersChanged } from '@/api/generated/auth/AuthUsersChanged'
import type { AuthUsersCleared } from '@/api/generated/auth/AuthUsersCleared'
import type { AuthUsersParams } from '@/api/generated/auth/AuthUsersParams'
import { type LiveChannel, type SubscriptionStatus, liveChannel } from '@/lib/live/channel'
import { type FeedStore, createFeedStore } from '@/lib/live/feed-store'
import { declareTopic } from '@/lib/live/topics'
import {
  type Handlers,
  createInvalidator,
  useInvalidateOn,
  useLiveTopic,
} from '@/lib/live/use-live-topic'
import {
  ACTIVITY_CAPACITY,
  MESSAGE_CAPACITY,
  activityPageQuery,
  authKeys,
  messagesPageQuery,
  olderActivity,
  olderMessages,
} from './queries'
import {
  type TenantScope,
  activityTopicParams,
  configTopicParams,
  inboxTopicParams,
  usersTopicParams,
} from './tenant-scope'

declare module '@/lib/live/topics' {
  interface TopicMap {
    'auth.users': {
      params: AuthUsersParams
      events: { changed: AuthUsersChanged; cleared: AuthUsersCleared }
    }
    'auth.activity': { params: AuthActivityParams; events: { calls: AuthActivityBatch } }
    'auth.inbox': { params: AuthInboxParams; events: { messages: AuthInboxBatch } }
    'auth.config': { params: AuthConfigParams; events: { changed: AuthConfigChanged } }
    'auth.hooks': { params: AuthConfigParams; events: { changed: Record<string, never> } }
  }
}

// The feeds resume from each subscriber's own cursor; the others carry keys
// (their cursor a state the engine compares), so the browser shares one
// engine subscription per parameters.
declareTopic('auth.users', 'none')
declareTopic('auth.activity', 'replay')
declareTopic('auth.inbox', 'replay')
declareTopic('auth.config', 'none')
declareTopic('auth.hooks', 'none')

// ------------------------------------------------------------------ users

/**
 * The record fields a minted ID token carries: an engine token minted
 * before one of them changed no longer says what a sign-in would.
 */
export const TOKEN_FIELDS: ReadonlySet<string> = new Set([
  'customAttributes',
  'disabled',
  'email',
  'emailVerified',
  'phoneNumber',
  'providerUserInfo',
  'mfaInfo',
])

/** What one `auth.users` window means for a page. */
export interface UsersWindow {
  /** Every uid it names, once each: what `applyKeys` reads again. */
  uids: string[]
  created: string[]
  updated: string[]
  deleted: string[]
  /** Some user's custom claims changed: the claim keys (`claimKeysQuery`) are stale. */
  claimsChanged: boolean
  /** Users whose engine tokens are stale: deleted, or a field a token carries changed. */
  staleTokens: string[]
}

export function readUsersWindow(changed: AuthUsersChanged): UsersWindow {
  const window: UsersWindow = {
    uids: [],
    created: [],
    updated: [],
    deleted: [],
    claimsChanged: false,
    staleTokens: [],
  }
  const seen = new Set<string>()
  const stale = new Set<string>()
  for (const entry of changed.changes) {
    if (!seen.has(entry.uid)) {
      seen.add(entry.uid)
      window.uids.push(entry.uid)
    }
    window[entry.change].push(entry.uid)
    if (entry.fields.includes('customAttributes')) window.claimsChanged = true
    if (entry.change === 'deleted' || entry.fields.some((field) => TOKEN_FIELDS.has(field)))
      stale.add(entry.uid)
  }
  window.staleTokens = [...stale]
  return window
}

/**
 * `auth.users` for a users scope (the project's users or one tenant's)
 * while `project` is known. A window's uids go to `applyKeys`; `cleared`,
 * `reset` and `end` mean "start the table again".
 */
export function useUsersTopic(
  project: string,
  scope: TenantScope,
  handlers: Handlers<'auth.users'>,
): SubscriptionStatus {
  return useLiveTopic(
    'auth.users',
    project === '' ? null : usersTopicParams(project, scope),
    handlers,
  )
}

// ------------------------------------------------------------------ config, hooks

/**
 * `auth.config` while `project` is known: a tenant created, changed or
 * deleted, or the project's switches changed. The tenant picker, the
 * settings it names and the summary are read again; `onChanged` lets a
 * page patch its tenants table (`applyKeys([tenant])`) or say that the
 * tenant it shows was deleted.
 */
export function useConfigLive(
  project: string,
  handlers: {
    onChanged?: (change: AuthConfigChanged) => void
    onReset?: () => void
  } = {},
): SubscriptionStatus {
  const queryClient = useQueryClient()
  const refresh = (keys: readonly QueryKey[]) => {
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey })
  }
  return useLiveTopic('auth.config', project === '' ? null : configTopicParams(project), {
    onChanged: (change) => {
      refresh([
        authKeys.allTenantPicker(project),
        authKeys.config(project, change.tenant ?? ''),
        authKeys.summary(project),
      ])
      handlers.onChanged?.(change)
    },
    onReset: () => {
      refresh([
        authKeys.allTenantPicker(project),
        authKeys.allConfig(project),
        authKeys.summary(project),
      ])
      handlers.onReset?.()
    },
  })
}

/** `auth.hooks` while `project` is known: which blocking functions run, read again when it changes. */
export function useHooksLive(project: string): SubscriptionStatus {
  const key = authKeys.hooks(project)
  return useInvalidateOn('auth.hooks', project === '' ? null : configTopicParams(project), {
    keys: () => [key],
    resetKeys: [key],
  })
}

// ------------------------------------------------------------------ feeds

/** How long a feed's first page (its facets) waits between refreshes while batches arrive, ms. */
export const FACETS_REFRESH_MS = 2_000

/** What a batch did to a feed store. */
export interface BatchEffect {
  /** Items added or changed. */
  items: number
  /** The engine's list was cleared (`DELETE /activity`, `DELETE /messages`). */
  cleared: boolean
}

/** One Activity batch into its store: calls pushed in order (newest last), `cleared` empties it. */
export function applyActivityBatch(
  store: FeedStore<AuthActivitySummary>,
  batch: AuthActivityBatch,
): BatchEffect {
  const effect: BatchEffect = { items: 0, cleared: false }
  let calls: AuthActivitySummary[] = []
  const flush = () => {
    if (calls.length === 0) return
    store.push(calls)
    effect.items += calls.length
    calls = []
  }
  for (const item of batch.items) {
    if (item.kind === 'call') calls.push(item.summary)
    else {
      flush()
      store.clear()
      effect.cleared = true
    }
  }
  flush()
  return effect
}

/**
 * One Inbox batch into its store: an issued message is pushed, a used one is
 * marked where it stands (`upsert`, the row keeps its place; one the store
 * does not hold is left alone), `cleared` empties it.
 */
export function applyInboxBatch(store: FeedStore<AuthMessage>, batch: AuthInboxBatch): BatchEffect {
  const effect: BatchEffect = { items: 0, cleared: false }
  let issued: AuthMessage[] = []
  const flush = () => {
    if (issued.length === 0) return
    store.push(issued)
    effect.items += issued.length
    issued = []
  }
  for (const item of batch.items) {
    if (item.kind === 'issued') {
      issued.push(item.message)
      continue
    }
    flush()
    if (item.kind === 'cleared') {
      store.clear()
      effect.cleared = true
      continue
    }
    const row = store.at(store.indexOf(String(item.id)))
    if (row?.kind !== 'item') continue
    store.upsert([{ ...row.item, used: true, usedAt: item.usedAt, usedBy: item.usedBy }])
    effect.items += 1
  }
  flush()
  return effect
}

/** The parts of a feed's first page the feed itself reads. */
interface FeedPage<T> {
  items: T[]
  nextCursor: string | null
  liveAfter: string
}

/** What a feed has been filled from: its scope's first page, and how far back it has paged. */
interface Seed<T> {
  key: string
  store: FeedStore<T>
  liveAfter: string
  older: string | null
}

/** A feed as a page draws it. */
export interface AuthFeed<T> {
  /** The rows, newest last; `FeedList order="newest-first"` draws them. */
  store: FeedStore<T>
  /** The first page has been read and the live tail is (being) subscribed. */
  ready: boolean
  /** Older history the engine keeps beyond what is loaded, while the store has room. */
  hasOlder: boolean
  loadingOlder: boolean
  /** Reads the next older page into the front of the store (FeedList's `loadMore`). */
  loadOlder: () => void
  /** This page's subscription: `LiveNotice` when it ended or was refused. */
  status: SubscriptionStatus
}

const activityKey = (call: AuthActivitySummary) => String(call.id)
const messageKey = (message: AuthMessage) => String(message.id)

/**
 * The machinery both feeds share: a store per capacity, seeded once per
 * scope from the first page (a refreshed first page only brings facets),
 * seeded again after an engine restart from the new engine's page, and the
 * older pages read on demand. `seeded` is undefined until the scope's
 * first page is in the store: the live tail is subscribed only then, after
 * its `liveAfter`.
 */
function useSeededFeed<T>(options: {
  queryKey: QueryKey
  capacity: number
  key: (item: T) => string
  first: FeedPage<T> | undefined
  firstUpdatedAt: number
  fetchOlder: (cursor: string, signal: AbortSignal) => Promise<FeedPage<T>>
  channel: LiveChannel
}) {
  const queryClient = useQueryClient()
  const { capacity, key: itemKey } = options
  const scopeKey = `${hashKey(options.queryKey)} ${capacity}`
  const store = useMemo(
    () => createFeedStore<T>({ max: capacity, key: itemKey }),
    [capacity, itemKey],
  )
  const [seed, setSeed] = useState<Seed<T> | undefined>(undefined)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // What handlers read: they run outside rendering, against the latest.
  const current = useRef<Seed<T> | undefined>(undefined)
  const latestKey = useRef(scopeKey)
  // A page read before an engine restart belongs to the old engine.
  const notBefore = useRef(0)
  const older = useRef<AbortController | undefined>(undefined)
  const [refresher] = useState(() =>
    createInvalidator(
      (queryKey) => void queryClient.invalidateQueries({ queryKey, exact: true }),
      FACETS_REFRESH_MS,
    ),
  )
  useEffect(() => () => refresher.dispose(), [refresher])

  useLayoutEffect(() => {
    latestKey.current = scopeKey
    const first = options.first
    if (!first || options.firstUpdatedAt < notBefore.current) return
    const held = current.current
    if (held?.key === scopeKey && held.store === store) return
    older.current?.abort()
    store.clear()
    store.push(first.items.toReversed())
    const next: Seed<T> = {
      key: scopeKey,
      store,
      liveAfter: first.liveAfter,
      older: first.nextCursor,
    }
    current.current = next
    setSeed(next)
    setLoadingOlder(false)
    // A refreshed first page (the facets) changes nothing here; after an
    // engine restart the next page read seeds again (`firstUpdatedAt`).
  }, [options.first, options.firstUpdatedAt, scopeKey, store])

  const { channel } = options
  useEffect(
    () =>
      channel.onEngineRestart(() => {
        // Every query was just invalidated; the new engine's first page
        // seeds the feed again, and nothing of the old one is shown.
        notBefore.current = Date.now()
        older.current?.abort()
        current.current = undefined
        store.clear()
        setSeed(undefined)
      }),
    [channel, store],
  )
  useEffect(() => () => older.current?.abort(), [])

  const seeded = seed?.key === scopeKey && seed.store === store ? seed : undefined
  /** Whether an event belongs to what is on screen (not to a scope that was left). */
  const accepting = () =>
    current.current !== undefined &&
    current.current.key === latestKey.current &&
    current.current.store === store

  const loadOlder = () => {
    const held = current.current
    if (!held || held.older === null || older.current || !accepting()) return
    if (store.snapshot().size >= capacity) return
    const abort = new AbortController()
    older.current = abort
    setLoadingOlder(true)
    options
      .fetchOlder(held.older, abort.signal)
      .then(
        (page) => {
          if (abort.signal.aborted || current.current !== held) return
          store.prepend(page.items.toReversed())
          const next: Seed<T> = { ...held, older: page.nextCursor }
          current.current = next
          setSeed(next)
        },
        () => {
          // Nothing more is offered for this scope; the list keeps what it has.
          if (abort.signal.aborted || current.current !== held) return
          const next: Seed<T> = { ...held, older: null }
          current.current = next
          setSeed(next)
        },
      )
      .finally(() => {
        if (older.current === abort) older.current = undefined
        setLoadingOlder(false)
      })
  }

  return {
    store,
    seeded,
    accepting,
    loadingOlder,
    loadOlder,
    /** A batch arrived: the first page's facets are read again, at most every 2 s. */
    refreshFirst: () => refresher.push([options.queryKey]),
    /** The list was cleared: nothing older to page. */
    cleared: () => {
      const held = current.current
      if (!held) return
      const next: Seed<T> = { ...held, older: null }
      current.current = next
      setSeed(next)
    },
  }
}

/** Activity as a feed: the first page, the live tail after it, and older pages on demand. */
export function useActivityFeed(options: {
  project: string
  scope: TenantScope
  q: string
  includeConsole: boolean
  /** `AuthSummary.activityCapacity`; the engine's default until it is known. */
  capacity?: number | undefined
  channel?: LiveChannel | undefined
}): AuthFeed<AuthActivitySummary> & {
  page: AuthActivityPage | undefined
  facets: AuthActivityFacets | null | undefined
  /** `--no-diagnostics` keeps no request bodies: Replay and the bodies are unavailable. */
  bodiesRetained: boolean | undefined
  error: Error | null
} {
  const { project, scope, q, includeConsole } = options
  const capacity = options.capacity ?? ACTIVITY_CAPACITY
  const channel = options.channel ?? liveChannel
  const pageQuery = activityPageQuery(project, scope, q, includeConsole)
  const first = useQuery({ ...pageQuery, enabled: project !== '' })
  const feed = useSeededFeed({
    queryKey: pageQuery.queryKey,
    capacity,
    key: activityKey,
    first: first.data,
    firstUpdatedAt: first.dataUpdatedAt,
    fetchOlder: (cursor, signal) =>
      olderActivity(project, scope, q, includeConsole, cursor, signal),
    channel,
  })
  const status = useLiveTopic(
    'auth.activity',
    feed.seeded ? activityTopicParams(project, scope, q, includeConsole) : null,
    {
      onCalls: (batch) => {
        if (!feed.accepting()) return
        const effect = applyActivityBatch(feed.store, batch)
        if (effect.cleared) feed.cleared()
        if (effect.items > 0 || effect.cleared) feed.refreshFirst()
      },
      onReset: (_reason, missed) => {
        if (feed.accepting()) feed.store.gap(missed, capacity)
      },
    },
    channel,
    { after: feed.seeded?.liveAfter },
  )
  return {
    store: feed.store,
    ready: feed.seeded !== undefined,
    hasOlder: typeof feed.seeded?.older === 'string',
    loadingOlder: feed.loadingOlder,
    loadOlder: feed.loadOlder,
    status,
    page: first.data,
    facets: first.data?.facets,
    bodiesRetained: first.data?.bodiesRetained,
    error: first.error,
  }
}

/** The Inbox as a feed, as `useActivityFeed`. */
export function useInboxFeed(options: {
  project: string
  scope: TenantScope
  q: string
  /** `AuthSummary.messageCapacity`; the engine's default until it is known. */
  capacity?: number | undefined
  channel?: LiveChannel | undefined
}): AuthFeed<AuthMessage> & {
  page: AuthMessagePage | undefined
  facets: AuthMessageFacets | null | undefined
  error: Error | null
} {
  const { project, scope, q } = options
  const capacity = options.capacity ?? MESSAGE_CAPACITY
  const channel = options.channel ?? liveChannel
  const pageQuery = messagesPageQuery(project, scope, q)
  const first = useQuery({ ...pageQuery, enabled: project !== '' })
  const feed = useSeededFeed({
    queryKey: pageQuery.queryKey,
    capacity,
    key: messageKey,
    first: first.data,
    firstUpdatedAt: first.dataUpdatedAt,
    fetchOlder: (cursor, signal) => olderMessages(project, scope, q, cursor, signal),
    channel,
  })
  const status = useLiveTopic(
    'auth.inbox',
    feed.seeded ? inboxTopicParams(project, scope, q) : null,
    {
      onMessages: (batch) => {
        if (!feed.accepting()) return
        const effect = applyInboxBatch(feed.store, batch)
        if (effect.cleared) feed.cleared()
        if (effect.items > 0 || effect.cleared) feed.refreshFirst()
      },
      onReset: (_reason, missed) => {
        if (feed.accepting()) feed.store.gap(missed, capacity)
      },
    },
    channel,
    { after: feed.seeded?.liveAfter },
  )
  return {
    store: feed.store,
    ready: feed.seeded !== undefined,
    hasOlder: typeof feed.seeded?.older === 'string',
    loadingOlder: feed.loadingOlder,
    loadOlder: feed.loadOlder,
    status,
    page: first.data,
    facets: first.data?.facets,
    error: first.error,
  }
}
