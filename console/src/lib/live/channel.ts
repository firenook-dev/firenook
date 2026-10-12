// The browser's one live connection (foundation spec §6). A page subscribes
// to a topic; the channel holds the subscription while the page is mounted,
// resumes it from its last cursor across a dropped connection, a new leader
// tab or a hidden spell, and says what state it is in.
//
// One tab leads (`leader.ts`): it owns the `EventSource` on
// `/console/api/v1/live`, adds and removes subscriptions on the engine with
// one POST per microtask, and relays every event to the tab that asked for
// it. Topics that resume by comparing state (`compare`) or that only
// invalidate (`none`) ride one engine subscription per parameters for the
// whole browser; feeds (`replay`) get their own, because each subscriber
// resumes from its own cursor.
//
// A hidden tab never connects: it registers its subscriptions and waits to
// be shown. A tab hidden for 20 s gives its subscriptions back (at once on
// `freeze` and `pagehide`), so engine work follows what somebody looks at.
// A new engine instance means the engine restarted: every query is
// invalidated, cursors are dropped and the restart toast says so — unless
// the new engine is another build, which the page's code no longer matches,
// and then `engineUpdated` asks for a reload instead.

import { create } from 'zustand'
import { API_BASE, ApiError, apiGet, apiSend } from '@/api/client'
import type { ApiErrorDetail } from '@/api/generated/ApiErrorDetail'
import type { LiveEnd } from '@/api/generated/live/LiveEnd'
import type { LiveHello } from '@/api/generated/live/LiveHello'
import type { LiveProbe } from '@/api/generated/live/LiveProbe'
import type { LiveReset } from '@/api/generated/live/LiveReset'
import type { LiveSubscriptionsResponse } from '@/api/generated/live/LiveSubscriptionsResponse'
import type { ResetReason } from '@/api/generated/live/ResetReason'
import {
  type Election,
  type HelloFacts,
  type LiveStatus,
  type LockManagerLike,
  RELAY_CHANNEL,
  type RelayChannelLike,
  type RelayMessage,
  createElection,
} from './leader'
import { type LiveEnvelope, resumeOf, topicKey, wireParams } from './topics'

export type { LiveStatus } from './leader'

/** One subscription's own state: the channel's, or what the engine said about this subscription. */
export type SubscriptionStatus = LiveStatus | 'ended' | 'refused'

/**
 * Where one subscription stands: waiting for the engine, taken, refused by
 * it, ended by it with an error (retried with backoff), or finished (the
 * topic said all it had to say).
 */
export type SubscriptionState = 'pending' | 'active' | 'refused' | 'ended' | 'finished'

export interface TopicListener {
  onEvent(name: string, data: unknown, cursor: string | undefined): void
  /** `missed` from `LiveReset` (null: another engine run, or the topic cannot count). */
  onReset(reason: ResetReason, missed: number | null): void
  /** `error` undefined: the topic finished; set: its source went away (the channel resubscribes with backoff). */
  onEnd(error: ApiErrorDetail | undefined): void
  onRefused?(error: ApiErrorDetail): void
  /** This subscription's state, whenever it changes; `useLiveTopic` reads it. */
  onState?(state: SubscriptionState): void
}

export interface LiveChannel {
  /** Subscribes (connecting on first use); returns the unsubscribe. */
  subscribe(topic: string, params: object, listener: TopicListener): () => void
  /** Called once per engine restart, after every query was invalidated. */
  onEngineRestart(callback: () => void): () => void
  /**
   * Offers every subscription of this tab the engine ended or refused again,
   * now: a page's "Live updates stopped · Retry" (`LiveNotice`). An ended one
   * also comes back by itself, with backoff; this skips the wait.
   */
  retry(): void
}

export interface LiveStatusState {
  status: LiveStatus
  /** The engine instance this tab last heard from. */
  instance: string | undefined
  /** When `status` last changed, ms since the epoch. */
  since: number
  /** Whether this tab holds the browser's connection. */
  leader: boolean
  /** A new engine instance of another build: the page asks for a reload. */
  engineUpdated: boolean
}

/** How long the channel waits before it gives a subscription back, gives up connecting or says offline. */
export interface LiveTiming {
  releaseMs: number
  connectingMs: number
  offlineMs: number
  idleMs: number
}

export const DEFAULT_TIMING: LiveTiming = {
  releaseMs: 20_000,
  connectingMs: 5_000,
  offlineMs: 30_000,
  idleMs: 5_000,
}

/** Journeys shorten the timings through this key, so they stay fast. */
export const TIMING_KEY = 'firenook.console.live-timing'

/** The timings, with whatever `firenook.console.live-timing` overrides. */
export function readTiming(storage: Pick<Storage, 'getItem'> | undefined): LiveTiming {
  let override: Record<string, unknown> = {}
  try {
    const text = storage?.getItem(TIMING_KEY)
    if (text) override = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Unreadable storage or a malformed value: the defaults stand.
  }
  const pick = (name: keyof LiveTiming) => {
    const value = override[name]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_TIMING[name]
  }
  return {
    releaseMs: pick('releaseMs'),
    connectingMs: pick('connectingMs'),
    offlineMs: pick('offlineMs'),
    idleMs: pick('idleMs'),
  }
}

/** Reconnect delays: 0.5 s doubling to 10 s, each ±20 %. */
export function backoffDelay(attempt: number, random: () => number): number {
  const base = Math.min(10_000, 500 * 2 ** Math.min(attempt, 10))
  return Math.round(base * (0.8 + 0.4 * random()))
}

/** What the channel uses of `EventSource`. */
export interface EventSourceLike {
  readonly readyState: number
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
}

/** `EventSource.CLOSED`, without reading the global the lint rule reserves for this directory. */
const CLOSED = 2

export interface ChannelEnvironment {
  locks?: LockManagerLike | undefined
  relay?: RelayChannelLike | undefined
  openEventSource(url: string): EventSourceLike
  /** POSTs JSON to the Console API; rejects with an `ApiError`. */
  post(path: string, body: unknown): Promise<unknown>
  /** `GET /live?probe=1`. */
  probe(): Promise<LiveProbe>
  document: { readonly visibilityState: DocumentVisibilityState } & EventTarget
  window: EventTarget
  storage?: Pick<Storage, 'getItem'> | undefined
  random(): number
}

export interface ChannelOptions {
  /** The store this channel reports into (the page's `useLiveStatus`). */
  store?: ReturnType<typeof createStatusStore>
  /** First on an engine restart: invalidate what the page shows. */
  onRestart?: () => void
  /** Last on an engine restart, after every `onEngineRestart` callback: the toast. */
  onRestarted?: () => void
}

export function createStatusStore() {
  return create<LiveStatusState>(() => ({
    status: 'paused',
    instance: undefined,
    since: Date.now(),
    leader: false,
    engineUpdated: false,
  }))
}

/** One `subscribe` call in this tab. */
interface LocalSub {
  id: string
  topic: string
  params: Record<string, unknown>
  listener: TopicListener
  cursor: string | undefined
  state: SubscriptionState
  attempt: number
  retry: ReturnType<typeof setTimeout> | undefined
}

/** A subscription some tab asked the leader for. */
interface TabSub {
  tab: string
  id: string
  topic: string
  params: Record<string, unknown>
  after: string | undefined
  engine: string | undefined
}

/** A subscription on the engine, held by the leader for one or more tab subscriptions. */
interface EngineSub {
  id: string
  topic: string
  params: Record<string, unknown>
  key: string
  shared: boolean
  compare: boolean
  members: Set<string>
  cursor: string | undefined
  /** `compare` topics: the newest event of each name, for a tab that joins later. */
  last: Map<string, string>
  /** Asked of the engine on the current connection. */
  sent: boolean
  accepted: boolean
}

/** The fields before `data` in an envelope the engine wrote, read without parsing `data`. */
const HEAD = /^\{"sub":"([^"\\]*)"(?:,"name":"([^"\\]*)","cursor":(?:null|"([^"\\]*)"))?/

function readHead(raw: string): { sub: string; name?: string; cursor?: string } | undefined {
  const match = HEAD.exec(raw)
  if (match?.[1] !== undefined) {
    return {
      sub: match[1],
      ...(match[2] === undefined ? {} : { name: match[2] }),
      ...(match[3] === undefined ? {} : { cursor: match[3] }),
    }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LiveEnvelope>
    if (typeof parsed.sub !== 'string') return undefined
    return {
      sub: parsed.sub,
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.cursor === 'string' ? { cursor: parsed.cursor } : {}),
    }
  } catch {
    return undefined
  }
}

/** A handler that throws is reported without stopping the channel. */
function safely(run: () => void) {
  try {
    run()
  } catch (error) {
    queueMicrotask(() => {
      throw error
    })
  }
}

function randomId(random: () => number, length: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let id = ''
  for (let index = 0; index < length; index += 1)
    id += alphabet[Math.floor(random() * alphabet.length)] ?? 'x'
  return id
}

export interface LiveChannelInstance extends LiveChannel {
  readonly tab: string
  readonly status: ReturnType<typeof createStatusStore>
  /** Lets go of everything: subscriptions, the connection, the locks. */
  close(): void
}

export function createLiveChannel(
  environment: ChannelEnvironment,
  options: ChannelOptions = {},
): LiveChannelInstance {
  const tab = `t${randomId(environment.random, 6)}`
  const store = options.store ?? createStatusStore()
  const restartCallbacks = new Set<() => void>()
  const timing = () => readTiming(environment.storage)
  let closed = false

  // ---- this tab -------------------------------------------------------

  const locals = new Map<string, LocalSub>()
  let localSerial = 0
  /** Visible, holding the tab lock, with its subscriptions given to a leader. */
  let engaged = false
  /** Shown, and engaging once the tab lock is held. */
  let wanted = false
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  /** The status the leader last reported. */
  let channelStatus: LiveStatus = 'connecting'
  /** The first `hello` this page saw: the build its code belongs to. */
  let pageBuild: { consoleBuild: string; engineRevision: string | null } | undefined
  let instance: string | undefined

  const election: Election = createElection(
    { locks: environment.locks, relay: environment.relay },
    tab,
    { onLead, onMessage, onTabGone },
  )

  function report() {
    const status: LiveStatus = engaged ? channelStatus : 'paused'
    const current = store.getState()
    const leader = election.isLeader()
    if (current.status !== status) store.setState({ status, since: Date.now(), leader })
    else if (current.leader !== leader) store.setState({ leader })
  }

  function setLocalState(local: LocalSub, state: SubscriptionState) {
    if (local.state === state) return
    local.state = state
    safely(() => local.listener.onState?.(state))
  }

  function offer(local: LocalSub) {
    if (!engaged) return
    const message: Extract<RelayMessage, { t: 'sub' }> = {
      t: 'sub',
      tab,
      id: local.id,
      topic: local.topic,
      params: local.params,
      ...(local.cursor === undefined ? {} : { after: local.cursor }),
    }
    if (election.isLeader()) leaderAdd(message)
    else election.send(message)
  }

  function withdrawLocal(local: LocalSub) {
    if (!engaged) return
    if (election.isLeader()) leaderRemove(local.id)
    else election.send({ t: 'unsub', tab, id: local.id })
  }

  /** Every subscription of this tab that should be on the engine, to the leader. */
  function offerAll(includeRefused: boolean) {
    for (const local of locals.values()) {
      if (local.state === 'finished') continue
      if (local.state === 'refused' && !includeRefused) continue
      if (local.state === 'refused') setLocalState(local, 'pending')
      offer(local)
    }
  }

  function engage() {
    wanted = true
    void election.ready.then(() => {
      if (!wanted || engaged || closed) return
      engaged = true
      report()
      election.send({ t: 'who', tab })
      offerAll(true)
      if (locals.size > 0) election.want()
    })
  }

  /** Gives this tab's subscriptions back; their cursors are kept for when it is shown again. */
  function release() {
    wanted = false
    clearTimeout(releaseTimer)
    releaseTimer = undefined
    if (!engaged) return
    if (election.isLeader()) stopLeading()
    else for (const local of locals.values()) election.send({ t: 'unsub', tab, id: local.id })
    engaged = false
    election.withdraw()
    report()
  }

  function onVisibility() {
    if (closed) return
    if (environment.document.visibilityState === 'visible') {
      clearTimeout(releaseTimer)
      releaseTimer = undefined
      engage()
    } else if ((engaged || wanted) && releaseTimer === undefined) {
      releaseTimer = setTimeout(release, timing().releaseMs)
    }
  }

  const onFreeze = () => release()

  /** Answers how this page relates to an engine's `hello`, dropping cursors when it is a new instance. */
  function seeInstance(hello: HelloFacts): 'same' | 'restarted' | 'updated' {
    if (instance === undefined) {
      instance = hello.instance
      pageBuild ??= { consoleBuild: hello.consoleBuild, engineRevision: hello.engineRevision }
      store.setState({ instance })
      return 'same'
    }
    if (hello.instance === instance) return 'same'
    instance = hello.instance
    store.setState({ instance })
    for (const local of locals.values()) local.cursor = undefined
    if (
      pageBuild &&
      (hello.consoleBuild !== pageBuild.consoleBuild ||
        hello.engineRevision !== pageBuild.engineRevision)
    ) {
      // The page's chunks and types belong to the engine that served it:
      // nothing is invalidated and nothing is toasted; the shell asks for
      // a reload.
      store.setState({ engineUpdated: true })
      return 'updated'
    }
    safely(() => options.onRestart?.())
    for (const callback of restartCallbacks) safely(callback)
    safely(() => options.onRestarted?.())
    return 'restarted'
  }

  function deliverLocal(local: LocalSub, kind: 'ev' | 'reset' | 'end', message: unknown) {
    if (kind === 'ev') {
      const envelope = message as LiveEnvelope
      if (envelope.cursor) local.cursor = envelope.cursor
      local.attempt = 0
      setLocalState(local, 'active')
      // `tick` only moves the cursor.
      if (envelope.name === 'tick') return
      safely(() =>
        local.listener.onEvent(envelope.name, envelope.data, envelope.cursor ?? undefined),
      )
      return
    }
    if (kind === 'reset') {
      const reset = message as LiveReset
      safely(() => local.listener.onReset(reset.reason, reset.missed))
      return
    }
    const end = message as LiveEnd
    if (end.error) {
      setLocalState(local, 'ended')
      const error = end.error
      safely(() => local.listener.onEnd(error))
      scheduleResubscribe(local)
    } else {
      setLocalState(local, 'finished')
      safely(() => local.listener.onEnd(undefined))
    }
  }

  /** An ended subscription comes back by itself, with the reconnect backoff. */
  function scheduleResubscribe(local: LocalSub) {
    clearTimeout(local.retry)
    const delay = backoffDelay(local.attempt, environment.random)
    local.attempt += 1
    local.retry = setTimeout(() => {
      local.retry = undefined
      if (locals.get(local.id) !== local || local.state !== 'ended') return
      setLocalState(local, 'pending')
      offer(local)
    }, delay)
  }

  /** Delivers one engine message to this tab's subscriptions among `ids`, parsing it once. */
  function deliverRaw(ids: Iterable<string>, kind: 'ev' | 'reset' | 'end', raw: string) {
    let parsed: unknown
    let read = false
    for (const id of ids) {
      const local = locals.get(id)
      if (!local) continue
      if (!read) {
        read = true
        try {
          parsed = JSON.parse(raw)
        } catch {
          return
        }
      }
      deliverLocal(local, kind, parsed)
    }
  }

  function refuseLocal(ids: Iterable<string>, error: ApiErrorDetail) {
    for (const id of ids) {
      const local = locals.get(id)
      if (!local) continue
      setLocalState(local, 'refused')
      safely(() => local.listener.onRefused?.(error))
    }
  }

  function acceptLocal(ids: Iterable<string>) {
    for (const id of ids) {
      const local = locals.get(id)
      if (local && local.state === 'pending') setLocalState(local, 'active')
    }
  }

  function onMessage(message: RelayMessage) {
    if (closed) return
    const leading = election.isLeader()
    switch (message.t) {
      case 'sub':
        if (leading) {
          election.watch(message.tab)
          leaderAdd(message)
        }
        return
      case 'unsub':
        if (leading) leaderRemove(message.id)
        return
      case 'who':
        if (leading) announce()
        return
      case 'hello': {
        if (leading || !engaged) return
        const seen = seeInstance(message)
        channelStatus = 'live'
        report()
        // The leader may be new and know nothing of this tab: offer every
        // subscription again (a known one is ignored).
        offerAll(seen !== 'same')
        return
      }
      case 'ev':
        if (!leading) deliverRaw(message.subs, message.kind, message.raw)
        return
      case 'accepted':
        if (!leading) acceptLocal(message.subs)
        return
      case 'refused':
        if (!leading) refuseLocal(message.subs, message.error)
        return
      case 'status':
        if (!leading) {
          channelStatus = message.status
          report()
        }
        return
      case 'stopping':
        if (!leading) {
          channelStatus = 'offline'
          report()
        }
        return
      case 'bye':
        if (!leading) {
          channelStatus = 'connecting'
          report()
        }
        return
    }
  }

  // ---- the leader -------------------------------------------------------

  let tabSubs = new Map<string, TabSub>()
  let engineSubs = new Map<string, EngineSub>()
  let sharedByKey = new Map<string, EngineSub>()
  const removes = new Set<string>()
  let engineSerial = 0
  /** Bumped whenever this tab starts or stops leading, so late answers are dropped. */
  let generation = 0
  let source: EventSourceLike | undefined
  let connection: string | undefined
  let lastHello: HelloFacts | undefined
  let heardHello = false
  let dropping = false
  let attempt = 0
  let posting = false
  let flushQueued = false
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let offlineTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let flushRetry: ReturnType<typeof setTimeout> | undefined

  function onLead() {
    if (closed || !engaged) {
      election.withdraw()
      return
    }
    generation += 1
    tabSubs = new Map()
    engineSubs = new Map()
    sharedByKey = new Map()
    removes.clear()
    attempt = 0
    dropping = false
    setChannelStatus('connecting')
    offerAll(false)
    connect()
  }

  function setChannelStatus(status: LiveStatus) {
    channelStatus = status
    report()
    election.send({ t: 'status', leader: tab, status })
  }

  function announce() {
    if (connection && lastHello) election.send({ t: 'hello', leader: tab, ...lastHello })
    election.send({ t: 'status', leader: tab, status: channelStatus })
  }

  function leaderAdd(message: Omit<TabSub, 'engine' | 'after'> & { after?: string }) {
    clearTimeout(idleTimer)
    idleTimer = undefined
    // A tab offering a subscription it already holds: nothing to do.
    if (tabSubs.has(message.id)) return
    const key = topicKey(message.topic, message.params)
    const resume = resumeOf(message.topic)
    const sub: TabSub = {
      tab: message.tab,
      id: message.id,
      topic: message.topic,
      params: message.params,
      after: message.after,
      engine: undefined,
    }
    tabSubs.set(sub.id, sub)
    if (resume !== 'replay') {
      const engine = sharedByKey.get(key)
      if (engine) {
        engine.members.add(sub.id)
        sub.engine = engine.id
        if (engine.accepted) {
          announceAccepted([sub])
          // What every other tab already knows, for this one too.
          if (engine.compare) for (const raw of engine.last.values()) route([sub], 'ev', raw)
        }
        return
      }
    }
    engineSerial += 1
    const engine: EngineSub = {
      id: `${tab}.${engineSerial}`,
      topic: sub.topic,
      params: sub.params,
      key,
      shared: resume !== 'replay',
      compare: resume === 'compare',
      members: new Set([sub.id]),
      cursor: sub.after,
      last: new Map(),
      sent: false,
      accepted: false,
    }
    engineSubs.set(engine.id, engine)
    if (engine.shared) sharedByKey.set(key, engine)
    sub.engine = engine.id
    scheduleFlush()
  }

  function leaderRemove(id: string) {
    const sub = tabSubs.get(id)
    if (!sub) return
    tabSubs.delete(id)
    const engine = sub.engine === undefined ? undefined : engineSubs.get(sub.engine)
    if (engine) {
      engine.members.delete(id)
      if (engine.members.size === 0) dropEngine(engine, true)
    }
    idleCheck()
  }

  /**
   * The last subscriber of the browser went: the connection closes after
   * `idleMs`, since a navigation usually brings one back within moments.
   * A subscription the engine refused still counts for this tab: the
   * connection also says when the engine stops or restarts, which the page
   * that asked wants to know.
   */
  function idleCheck() {
    if (!election.isLeader() || tabSubs.size > 0 || locals.size > 0) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (election.isLeader() && tabSubs.size === 0 && locals.size === 0) stopLeading()
    }, timing().idleMs)
  }

  function dropEngine(engine: EngineSub, tellEngine: boolean) {
    engineSubs.delete(engine.id)
    if (sharedByKey.get(engine.key) === engine) sharedByKey.delete(engine.key)
    if (tellEngine && engine.sent) {
      removes.add(engine.id)
      scheduleFlush()
    }
  }

  function onTabGone(gone: string) {
    // Removing the entry being visited is safe in a Map's iteration.
    for (const sub of tabSubs.values()) if (sub.tab === gone) leaderRemove(sub.id)
  }

  /** Delivers to tab subscriptions: this tab's directly, the others' over the relay. */
  function route(subs: readonly TabSub[], kind: 'ev' | 'reset' | 'end', raw: string) {
    const mine: string[] = []
    const theirs: string[] = []
    for (const sub of subs) (sub.tab === tab ? mine : theirs).push(sub.id)
    if (theirs.length > 0) election.send({ t: 'ev', kind, raw, subs: theirs })
    if (mine.length > 0) deliverRaw(mine, kind, raw)
  }

  function announceAccepted(subs: readonly TabSub[]) {
    const theirs: string[] = []
    for (const sub of subs) {
      if (sub.tab === tab) acceptLocal([sub.id])
      else theirs.push(sub.id)
    }
    if (theirs.length > 0) election.send({ t: 'accepted', subs: theirs })
  }

  function refuseEngine(engine: EngineSub, error: ApiErrorDetail) {
    dropEngine(engine, false)
    const theirs: string[] = []
    for (const id of engine.members) {
      const sub = tabSubs.get(id)
      tabSubs.delete(id)
      if (!sub) continue
      if (sub.tab === tab) refuseLocal([id], error)
      else theirs.push(id)
    }
    if (theirs.length > 0) election.send({ t: 'refused', subs: theirs, error })
  }

  function members(engine: EngineSub): TabSub[] {
    const found: TabSub[] = []
    for (const id of engine.members) {
      const sub = tabSubs.get(id)
      if (sub) found.push(sub)
    }
    return found
  }

  function onEngineMessage(kind: 'ev' | 'reset' | 'end', raw: string) {
    const head = readHead(raw)
    if (!head) return
    const engine = engineSubs.get(head.sub)
    if (!engine) return
    if (kind === 'ev') {
      if (head.cursor !== undefined) engine.cursor = head.cursor
      if (engine.compare && head.name !== undefined && head.name !== 'tick')
        engine.last.set(head.name, raw)
    }
    const subs = members(engine)
    if (kind === 'end') {
      // The engine forgot it; each tab decides whether to come back.
      dropEngine(engine, false)
      for (const sub of subs) tabSubs.delete(sub.id)
    }
    route(subs, kind, raw)
  }

  function scheduleFlush() {
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(() => {
      flushQueued = false
      void flush()
    })
  }

  /** One POST with everything added and removed since the last; never two at once, so they stay in order. */
  async function flush() {
    if (posting || connection === undefined || !election.isLeader()) return
    const adds = [...engineSubs.values()].filter((engine) => !engine.sent)
    const remove = [...removes]
    if (adds.length === 0 && remove.length === 0) return
    posting = true
    removes.clear()
    for (const engine of adds) engine.sent = true
    const asked = connection
    const leading = generation
    try {
      const answer = (await environment.post(`/live/${encodeURIComponent(asked)}/subscriptions`, {
        add: adds.map((engine) => ({
          id: engine.id,
          topic: engine.topic,
          params: engine.params,
          ...(engine.cursor === undefined ? {} : { after: engine.cursor }),
        })),
        remove,
      })) as LiveSubscriptionsResponse
      if (leading !== generation || asked !== connection) return
      for (const id of answer.accepted) {
        const engine = engineSubs.get(id)
        if (!engine) continue
        engine.accepted = true
        announceAccepted(members(engine))
      }
      for (const refusal of answer.refused) {
        const engine = engineSubs.get(refusal.id)
        if (engine) refuseEngine(engine, refusal.error)
      }
    } catch (error) {
      if (leading !== generation || asked !== connection) return
      if (error instanceof ApiError && error.status === 404) {
        // The connection is gone; the next `hello` adds everything again.
        connection = undefined
      } else if (error instanceof ApiError && error.status === 400) {
        const detail: ApiErrorDetail = {
          code:
            error.code === 'network' || error.code === 'unknown' ? 'invalid-argument' : error.code,
          message: error.message,
          ...(error.fix === undefined ? {} : { fix: error.fix }),
        }
        for (const engine of adds)
          if (engineSubs.get(engine.id) === engine) refuseEngine(engine, detail)
      } else {
        // The request did not get through; try again shortly. A dropped
        // connection replaces all of this with the next `hello`.
        for (const engine of adds) engine.sent = false
        for (const id of remove) removes.add(id)
        clearTimeout(flushRetry)
        flushRetry = setTimeout(() => {
          flushRetry = undefined
          scheduleFlush()
        }, 1_000)
      }
    } finally {
      posting = false
      if (leading === generation && flushRetry === undefined) scheduleFlush()
    }
  }

  function closeSource() {
    clearTimeout(connectTimer)
    connectTimer = undefined
    source?.close()
    source = undefined
    connection = undefined
    heardHello = false
  }

  function connect() {
    clearTimeout(retryTimer)
    retryTimer = undefined
    closeSource()
    if (!election.isLeader() || closed) return
    const opened = environment.openEventSource(`${API_BASE}/live`)
    source = opened
    const mine = (run: (event: MessageEvent<string>) => void) => (event: MessageEvent<string>) => {
      if (source === opened) run(event)
    }
    opened.addEventListener(
      'hello',
      mine((event) => onHello(JSON.parse(event.data) as LiveHello)),
    )
    opened.addEventListener(
      'ev',
      mine((event) => onEngineMessage('ev', event.data)),
    )
    opened.addEventListener(
      'reset',
      mine((event) => onEngineMessage('reset', event.data)),
    )
    opened.addEventListener(
      'end',
      mine((event) => onEngineMessage('end', event.data)),
    )
    opened.addEventListener(
      'stopping',
      mine(() => onStopping()),
    )
    opened.addEventListener(
      'error',
      mine(() => onError(opened)),
    )
    watchConnecting(opened)
  }

  /** A source that is not open within `connectingMs` is closed and retried on the channel's own schedule. */
  function watchConnecting(opened: EventSourceLike) {
    clearTimeout(connectTimer)
    connectTimer = setTimeout(() => {
      connectTimer = undefined
      if (source !== opened || heardHello) return
      closeSource()
      scheduleRetry()
    }, timing().connectingMs)
  }

  function onHello(hello: LiveHello) {
    clearTimeout(connectTimer)
    clearTimeout(offlineTimer)
    connectTimer = undefined
    offlineTimer = undefined
    attempt = 0
    dropping = false
    heardHello = true
    connection = hello.connection
    const facts: HelloFacts = {
      instance: hello.instance,
      consoleBuild: hello.consoleBuild,
      engineRevision: hello.engineRevision,
    }
    lastHello = facts
    if (seeInstance(facts) !== 'same') {
      // Another engine run: no cursor of the old one means anything.
      for (const sub of tabSubs.values()) sub.after = undefined
      for (const engine of engineSubs.values()) {
        engine.cursor = undefined
        engine.last.clear()
      }
      offerAll(true)
    }
    // A new connection holds nothing: every engine subscription is asked
    // for again, from its last cursor.
    removes.clear()
    for (const engine of engineSubs.values()) {
      engine.sent = false
      engine.accepted = false
    }
    setChannelStatus('live')
    election.send({ t: 'hello', leader: tab, ...facts })
    scheduleFlush()
  }

  function onError(opened: EventSourceLike) {
    connection = undefined
    if (opened.readyState === CLOSED) {
      // An HTTP answer that is not a stream: maybe too many connections.
      closeSource()
      beginDrop()
      const leading = generation
      void environment
        .probe()
        .then((probe) => {
          if (leading === generation && source === undefined && probe.connections >= probe.limit)
            setChannelStatus('too-many')
        })
        .catch(() => {
          // The engine is not answering at all; the retry finds out when it is.
        })
        .finally(() => {
          if (leading === generation && source === undefined && retryTimer === undefined)
            scheduleRetry()
        })
      return
    }
    if (heardHello) {
      // The browser reconnects by itself (it honours `retry: 1000`); if it
      // has not within `connectingMs`, the channel takes over.
      heardHello = false
      beginDrop()
      watchConnecting(opened)
      return
    }
    // Not yet open: retry on the channel's own schedule.
    closeSource()
    scheduleRetry()
  }

  function beginDrop() {
    if (dropping) return
    dropping = true
    if (channelStatus === 'live' || channelStatus === 'connecting') setChannelStatus('reconnecting')
    clearTimeout(offlineTimer)
    offlineTimer = setTimeout(() => {
      offlineTimer = undefined
      if (dropping && channelStatus === 'reconnecting') setChannelStatus('offline')
    }, timing().offlineMs)
  }

  function scheduleRetry() {
    beginDrop()
    clearTimeout(retryTimer)
    const delay = backoffDelay(attempt, environment.random)
    attempt += 1
    retryTimer = setTimeout(connect, delay)
  }

  function onStopping() {
    // Said at once: the engine is going, and the badge says so now rather
    // than after the reconnect attempts give up.
    closeSource()
    dropping = true
    clearTimeout(offlineTimer)
    offlineTimer = undefined
    setChannelStatus('offline')
    election.send({ t: 'stopping', leader: tab })
    scheduleRetry()
  }

  function stopLeading() {
    generation += 1
    election.send({ t: 'bye', leader: tab })
    closeSource()
    for (const timer of [retryTimer, offlineTimer, idleTimer, flushRetry]) clearTimeout(timer)
    retryTimer = undefined
    offlineTimer = undefined
    idleTimer = undefined
    flushRetry = undefined
    tabSubs.clear()
    engineSubs.clear()
    sharedByKey.clear()
    removes.clear()
    dropping = false
    channelStatus = 'connecting'
    election.withdraw()
    report()
  }

  // ---- start ------------------------------------------------------------

  environment.document.addEventListener('visibilitychange', onVisibility)
  environment.document.addEventListener('freeze', onFreeze)
  environment.document.addEventListener('resume', onVisibility)
  environment.window.addEventListener('pagehide', onFreeze)
  environment.window.addEventListener('pageshow', onVisibility)
  if (environment.document.visibilityState === 'visible') engage()

  return {
    tab,
    status: store,
    subscribe(topic, params, listener) {
      localSerial += 1
      const local: LocalSub = {
        id: `${tab}.s${localSerial}`,
        topic,
        params: wireParams(params),
        listener,
        cursor: undefined,
        state: 'pending',
        attempt: 0,
        retry: undefined,
      }
      locals.set(local.id, local)
      if (engaged) {
        offer(local)
        election.want()
      }
      return () => {
        if (locals.get(local.id) !== local) return
        locals.delete(local.id)
        clearTimeout(local.retry)
        if (local.state !== 'refused' && local.state !== 'finished') withdrawLocal(local)
        if (locals.size > 0) return
        if (election.isLeader()) idleCheck()
        else election.withdraw()
      }
    },
    onEngineRestart(callback) {
      restartCallbacks.add(callback)
      return () => {
        restartCallbacks.delete(callback)
      }
    },
    retry() {
      for (const local of locals.values()) {
        if (local.state !== 'ended' && local.state !== 'refused') continue
        clearTimeout(local.retry)
        local.retry = undefined
        setLocalState(local, 'pending')
        offer(local)
      }
    },
    close() {
      if (closed) return
      release()
      closed = true
      for (const local of locals.values()) clearTimeout(local.retry)
      locals.clear()
      environment.document.removeEventListener('visibilitychange', onVisibility)
      environment.document.removeEventListener('freeze', onFreeze)
      environment.document.removeEventListener('resume', onVisibility)
      environment.window.removeEventListener('pagehide', onFreeze)
      environment.window.removeEventListener('pageshow', onVisibility)
      election.close()
    },
  }
}

/** The browser's own pieces. */
function browserEnvironment(): ChannelEnvironment {
  const locks =
    typeof navigator !== 'undefined' && 'locks' in navigator
      ? (navigator.locks as unknown as LockManagerLike)
      : undefined
  const relay =
    typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(RELAY_CHANNEL)
  let storage: Storage | undefined
  try {
    storage = window.localStorage
  } catch {
    storage = undefined
  }
  return {
    locks,
    relay,
    openEventSource: (url) => new EventSource(url),
    post: (path, body) => apiSend('POST', path, body),
    probe: () => apiGet<LiveProbe>('/live', { probe: 1 }),
    document,
    window,
    storage,
    random: Math.random,
  }
}

/** This tab's view of the channel. */
export const useLiveStatus = createStatusStore()

let instanceOfPage: LiveChannelInstance | undefined
let restartHooks: Pick<ChannelOptions, 'onRestart' | 'onRestarted'> = {}

/**
 * What the page does when the engine restarts: the shell sets these once
 * (invalidate every query, toast). Kept apart from the channel so this
 * module does not pull the query client or the toasts into whoever imports
 * a type from it.
 */
export function setRestartHooks(hooks: Pick<ChannelOptions, 'onRestart' | 'onRestarted'>): void {
  restartHooks = hooks
}

function page(): LiveChannelInstance {
  instanceOfPage ??= createLiveChannel(browserEnvironment(), {
    store: useLiveStatus,
    onRestart: () => restartHooks.onRestart?.(),
    onRestarted: () => restartHooks.onRestarted?.(),
  })
  return instanceOfPage
}

/** The page's channel, created on first use. */
export const liveChannel: LiveChannel = {
  subscribe: (topic, params, listener) => page().subscribe(topic, params, listener),
  onEngineRestart: (callback) => page().onEngineRestart(callback),
  retry: () => page().retry(),
}
