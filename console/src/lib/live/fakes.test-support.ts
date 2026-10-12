// In-memory stand-ins for what the live channel uses of the browser: Web
// Locks, BroadcastChannel and EventSource, plus an engine that answers the
// subscriptions POST. Several "tabs" share one set, as tabs of one browser
// share the real ones. Test support only; no production code imports it.

import type { ApiErrorDetail } from '@/api/generated/ApiErrorDetail'
import type { LiveSubscribe } from '@/api/generated/live/LiveSubscribe'
import type { ChannelEnvironment, EventSourceLike } from './channel'
import type { LockManagerLike, RelayChannelLike } from './leader'

interface Waiter {
  callback: () => Promise<void> | void
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/** Web Locks, exclusive mode only, granted in request order. */
export class FakeLocks implements LockManagerLike {
  private held = new Set<string>()
  private queues = new Map<string, Waiter[]>()

  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void> | void) {
    return new Promise<unknown>((resolve, reject) => {
      const waiter: Waiter = { callback, resolve, reject }
      const signal = options.signal
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      signal?.addEventListener('abort', () => {
        const queue = this.queues.get(name) ?? []
        const at = queue.indexOf(waiter)
        if (at === -1) return
        queue.splice(at, 1)
        reject(new DOMException('aborted', 'AbortError'))
      })
      const queue = this.queues.get(name) ?? []
      queue.push(waiter)
      this.queues.set(name, queue)
      this.pump(name)
    })
  }

  isHeld(name: string): boolean {
    return this.held.has(name)
  }

  waiting(name: string): number {
    return this.queues.get(name)?.length ?? 0
  }

  /** What the browser does when the tab holding `name` crashes: the lock is free. */
  forceRelease(name: string) {
    this.held.delete(name)
    this.pump(name)
  }

  private pump(name: string) {
    if (this.held.has(name)) return
    const next = this.queues.get(name)?.shift()
    if (!next) return
    this.held.add(name)
    void Promise.resolve()
      .then(() => next.callback())
      .then(
        (value) => {
          this.held.delete(name)
          next.resolve(value)
          this.pump(name)
        },
        (error: unknown) => {
          this.held.delete(name)
          next.reject(error)
          this.pump(name)
        },
      )
  }
}

/** BroadcastChannel: every other open endpoint gets a copy, asynchronously. */
export class FakeRelayHub {
  private endpoints = new Set<FakeRelay>()

  endpoint(): FakeRelay {
    const relay = new FakeRelay(this.endpoints)
    this.endpoints.add(relay)
    return relay
  }
}

export class FakeRelay implements RelayChannelLike {
  open = true
  private listeners = new Set<(event: MessageEvent) => void>()
  private peers: Set<FakeRelay>
  constructor(peers: Set<FakeRelay>) {
    this.peers = peers
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
    this.listeners.delete(listener)
  }

  postMessage(message: unknown) {
    if (!this.open) return
    const copy = structuredClone(message)
    for (const peer of this.peers) {
      if (peer === this || !peer.open) continue
      queueMicrotask(() => {
        if (!peer.open) return
        for (const listener of peer.listeners) listener({ data: copy } as MessageEvent)
      })
    }
  }

  close() {
    this.open = false
    this.peers.delete(this)
  }
}

export class FakeSource implements EventSourceLike {
  readyState = 0
  connection: string | undefined
  readonly url: string
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()
  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  close() {
    this.readyState = 2
  }

  emit(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ data } as MessageEvent<string>)
  }

  get closed() {
    return this.readyState === 2
  }
}

interface Posted {
  connection: string
  add: LiveSubscribe[]
  remove: string[]
}

/** The engine: hands out connections and remembers what each subscribed to. */
export class FakeEngine {
  sources: FakeSource[] = []
  posts: Posted[] = []
  /** Topic → why the engine refuses it. */
  refuse = new Map<string, ApiErrorDetail>()
  /** Connection → subscription id → what was asked. */
  subscriptions = new Map<string, Map<string, LiveSubscribe>>()
  instance = 'i1'
  consoleBuild = 'b1'
  engineRevision: string | null = 'r1'
  probe = { connections: 1, limit: 64 }
  probeFails = false
  postFails: ((connection: string) => Error | undefined) | undefined
  private serial = 0

  open(url: string): FakeSource {
    const source = new FakeSource(url)
    this.sources.push(source)
    return source
  }

  /** The open sources: what is holding a connection now. */
  live(): FakeSource[] {
    return this.sources.filter((source) => !source.closed)
  }

  last(): FakeSource {
    const source = this.sources.at(-1)
    if (!source) throw new Error('no source was opened')
    return source
  }

  /** Answers a source's request with `hello`. */
  hello(source: FakeSource = this.last()) {
    this.serial += 1
    source.connection = `c${this.serial}`
    source.readyState = 1
    this.subscriptions.set(source.connection, new Map())
    source.emit(
      'hello',
      JSON.stringify({
        instance: this.instance,
        connection: source.connection,
        heartbeatMs: 15_000,
        limits: { subscriptions: 128 },
        consoleBuild: this.consoleBuild,
        engineRevision: this.engineRevision,
      }),
    )
  }

  async post(path: string, body: unknown) {
    const connection = decodeURIComponent(path.split('/')[2] ?? '')
    const request = body as { add: LiveSubscribe[]; remove: string[] }
    this.posts.push({ connection, add: request.add, remove: request.remove })
    const failure = this.postFails?.(connection)
    if (failure) throw failure
    const held = this.subscriptions.get(connection)
    if (!held) {
      const { ApiError } = await import('@/api/client')
      throw new ApiError(404, `No live connection named ${connection}.`, 'not-found')
    }
    for (const id of request.remove) held.delete(id)
    const accepted: string[] = []
    const refused: Array<{ id: string; error: ApiErrorDetail }> = []
    for (const add of request.add) {
      const error = this.refuse.get(add.topic)
      if (error) refused.push({ id: add.id, error })
      else {
        held.set(add.id, add)
        accepted.push(add.id)
      }
    }
    return { accepted, refused }
  }

  /** Every subscription the engine holds on `source`'s connection. */
  held(source: FakeSource = this.last()): LiveSubscribe[] {
    return [...(this.subscriptions.get(source.connection ?? '')?.values() ?? [])]
  }

  /** The engine subscription id for a topic on `source`. */
  idOf(topic: string, source: FakeSource = this.last()): string {
    const found = this.held(source).find((sub) => sub.topic === topic)
    if (!found) throw new Error(`nothing subscribed to ${topic}`)
    return found.id
  }

  ev(sub: string, name: string, cursor: string | null, data: unknown, source = this.last()) {
    source.emit(
      'ev',
      `{"sub":${JSON.stringify(sub)},"name":${JSON.stringify(name)},"cursor":${
        cursor === null ? 'null' : JSON.stringify(cursor)
      },"data":${JSON.stringify(data)}}`,
    )
  }

  reset(sub: string, reason: string, missed: number | null, source = this.last()) {
    source.emit('reset', JSON.stringify({ sub, reason, missed }))
  }

  end(sub: string, error: ApiErrorDetail | undefined, source = this.last()) {
    this.subscriptions.get(source.connection ?? '')?.delete(sub)
    source.emit('end', JSON.stringify(error ? { sub, error } : { sub }))
  }

  /** The stream drops; the browser would retry by itself. */
  drop(source = this.last()) {
    source.readyState = 0
    source.emit('error', '')
  }

  /** An answer that is not a stream (429, 503): the source is closed. */
  fail(source = this.last()) {
    source.readyState = 2
    source.emit('error', '')
  }
}

export class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
  show() {
    this.visibilityState = 'visible'
    this.dispatchEvent(new Event('visibilitychange'))
  }
  hide() {
    this.visibilityState = 'hidden'
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

export interface FakeTab {
  environment: ChannelEnvironment
  document: FakeDocument
  window: EventTarget
  relay: FakeRelay | undefined
  storage: Map<string, string>
}

/** A browser: shared locks and relay, one engine. */
export class FakeBrowser {
  locks = new FakeLocks()
  relays = new FakeRelayHub()
  engine = new FakeEngine()
  private seed = 1
  private shared: boolean

  constructor(shared = true) {
    this.shared = shared
  }

  tab(options: { hidden?: boolean } = {}): FakeTab {
    const document = new FakeDocument()
    if (options.hidden) document.visibilityState = 'hidden'
    const window = new EventTarget()
    const relay = this.shared ? this.relays.endpoint() : undefined
    const storage = new Map<string, string>()
    // A different, repeatable tab id per tab; jitter in the middle.
    let draws = 0
    const seed = this.seed
    this.seed += 1
    const random = () => {
      draws += 1
      return draws <= 6 ? ((seed * 7 + draws * 13) % 36) / 36 : 0.5
    }
    const environment: ChannelEnvironment = {
      locks: this.shared ? this.locks : undefined,
      relay,
      openEventSource: (url) => this.engine.open(url),
      post: (path, body) => this.engine.post(path, body),
      probe: async () => {
        if (this.engine.probeFails) throw new Error('no answer')
        return this.engine.probe
      },
      document,
      window,
      storage: { getItem: (key) => storage.get(key) ?? null },
      random,
    }
    return { environment, document, window, relay, storage }
  }
}

/** Lets every queued microtask (relay deliveries, lock grants, POST answers) run. */
export async function settle(rounds = 30) {
  // One microtask at a time, on purpose: each round lets the next hop run.
  // oxlint-disable-next-line no-await-in-loop
  for (let round = 0; round < rounds; round += 1) await Promise.resolve()
}
