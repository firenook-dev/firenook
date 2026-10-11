// What the security rules decided: one entry per request the rules had to
// judge, as the engine records them on its Requests feed — the same feed
// the official Emulator UI reads, so its events are kept exactly as they
// arrive and decoded here.
//
// Only requests the rules judge appear. The Admin SDK — Cloud Functions,
// servers, `firebase-admin`, and this console when it reads "As Admin" —
// skips the rules entirely, and a database with no rules file allows
// everything without asking; neither is ever recorded. That is the first
// thing an empty list has to say.
//
// Connected only while the rules page is open (the feed admits four
// clients). On connecting the engine replays what it still holds — the
// last 256 decisions of the last ten minutes — then streams new ones.

import { useEffect } from 'react'
import { create } from 'zustand'
import { API_BASE } from '@/api/client'
import type { FsValue } from '../value'

export type DecisionOutcome = 'allow' | 'deny' | 'error'
export type RulesMethod = 'get' | 'list' | 'create' | 'update' | 'delete'

export interface RulesDecision {
  requestId: string
  time: string
  outcome: DecisionOutcome
  method: RulesMethod
  /** Relative document path, or for a list the collection (group) it reads. */
  path: string
  database: string
  /** The uid the request carried; undefined for a client that is not signed in. */
  uid: string | undefined
  /** The decoded ID token claims; undefined when not signed in. */
  token: Record<string, FsValue> | undefined
  /** Rule lines that ran, with whether each allowed. */
  lines: Array<{ line: number; outcome: boolean }>
  /** The rules source that decided it; lines refer to this text. */
  rules: string
  /** The ruleset's release hash, which names that source. */
  rulesHash: string
  /** The document before the request; null when it does not exist, undefined for a list. */
  before: Record<string, FsValue> | null | undefined
  /** The document the write would leave; writes only. */
  after: Record<string, FsValue> | null | undefined
  /** Top-level fields an update adds, removes or changes. */
  changedKeys: string[] | undefined
  /** A list's limit and ordering, when it has them. */
  query: { limit: number | undefined; orderBy: string[] } | undefined
  inTransaction: boolean
  raw: unknown
}

/** A value as the rules runtime writes it into a Requests event. */
export interface RulesTypedValue {
  nullValue?: null
  boolValue?: boolean
  intValue?: string | number
  floatValue?: number | string
  stringValue?: string
  timestampValue?: string
  bytesValue?: string
  latlngValue?: { latitude?: number; longitude?: number }
  pathValue?: { segments?: Array<{ simple?: string }> }
  mapValue?: { fields?: Record<string, RulesTypedValue> }
  listValue?: { values?: RulesTypedValue[] }
  undefined?: Record<string, never>
}

/**
 * A rules value as the console's own value, so a decision's documents
 * read the way the grid and the inspector write them. Undefined for the
 * runtime's "undefined" marker, which is an absence, not a value.
 */
export function fromRulesValue(value: RulesTypedValue | undefined): FsValue | undefined {
  if (!value || value.undefined !== undefined) return undefined
  if (value.nullValue !== undefined) return { type: 'null' }
  if (value.boolValue !== undefined) return { type: 'boolean', value: value.boolValue }
  if (value.intValue !== undefined)
    return { type: 'number', value: Number(value.intValue), integer: true }
  if (value.floatValue !== undefined) {
    const number =
      typeof value.floatValue === 'number' ? value.floatValue : Number(value.floatValue)
    return { type: 'number', value: number, integer: false }
  }
  if (value.stringValue !== undefined) return { type: 'string', value: value.stringValue }
  if (value.timestampValue !== undefined) return { type: 'timestamp', value: value.timestampValue }
  if (value.bytesValue !== undefined) return { type: 'bytes', base64: value.bytesValue }
  if (value.latlngValue !== undefined)
    return {
      type: 'geopoint',
      latitude: value.latlngValue.latitude ?? 0,
      longitude: value.latlngValue.longitude ?? 0,
    }
  if (value.pathValue !== undefined) {
    const segments = (value.pathValue.segments ?? []).map((segment) => segment.simple ?? '')
    const full = segments.join('/')
    const at = segments.indexOf('documents')
    const path = at >= 0 ? segments.slice(at + 1).join('/') : full
    return { type: 'reference', value: `/${full}`, path }
  }
  if (value.mapValue !== undefined) return { type: 'map', fields: fromRulesFields(value.mapValue) }
  if (value.listValue !== undefined)
    return {
      type: 'array',
      items: (value.listValue.values ?? []).flatMap((item) => {
        const decoded = fromRulesValue(item)
        return decoded ? [decoded] : []
      }),
    }
  return undefined
}

function fromRulesFields(map: {
  fields?: Record<string, RulesTypedValue>
}): Record<string, FsValue> {
  const out: Record<string, FsValue> = {}
  for (const [key, item] of Object.entries(map.fields ?? {})) {
    const decoded = fromRulesValue(item)
    if (decoded) out[key] = decoded
  }
  return out
}

/** The `data` of a resource map (`{data, __name__, id}`), or null when there is none. */
function resourceData(value: RulesTypedValue | undefined): Record<string, FsValue> | null {
  const fields = value?.mapValue?.fields
  if (!fields) return null
  return fromRulesFields(fields.data?.mapValue ?? {})
}

/** Two values are the same, structurally. */
export function sameValue(left: FsValue | undefined, right: FsValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** The top-level keys a write adds, removes or changes. */
export function changedKeys(
  before: Record<string, FsValue> | null | undefined,
  after: Record<string, FsValue> | null | undefined,
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...keys].filter((key) => !sameValue(before?.[key], after?.[key])).toSorted()
}

interface Frame {
  requestId?: string
  time?: string
  outcome?: DecisionOutcome
  rules?: string
  rulesReleaseKey?: string
  granularAllowOutcomes?: Array<{ line: number; outcome: boolean }>
  rulesContext?: {
    method?: string
    path?: string | { undefined?: unknown }
    request?: RulesTypedValue
    resource?: RulesTypedValue
  }
}

const METHODS = new Set<RulesMethod>(['get', 'list', 'create', 'update', 'delete'])

/** One event off the feed, or undefined when it is not a rules decision. */
export function decodeDecision(text: string): RulesDecision | undefined {
  let frame: Frame
  try {
    frame = JSON.parse(text) as Frame
  } catch {
    return undefined
  }
  const context = frame.rulesContext
  if (!context || !frame.outcome) return undefined
  const fullPath = typeof context.path === 'string' ? context.path : ''
  const match = /^\/databases\/([^/]+)\/documents\/?(.*)$/.exec(fullPath)
  const request = context.request?.mapValue?.fields ?? {}
  const auth = request.auth?.mapValue?.fields
  const method = (context.method ?? '') as RulesMethod
  const writing = method === 'create' || method === 'update' || method === 'delete'
  const before = method === 'list' ? undefined : resourceData(context.resource)
  const after = writing ? resourceData(request.resource) : undefined
  const queryFields = request.query?.mapValue?.fields
  const releaseKey = frame.rulesReleaseKey ?? ''
  return {
    requestId: frame.requestId ?? crypto.randomUUID(),
    time: frame.time ?? new Date().toISOString(),
    outcome: frame.outcome,
    method: METHODS.has(method) ? method : 'get',
    path: listPath(match?.[2] ?? queryPath(request.path) ?? fullPath, method),
    database: match?.[1] ?? '(default)',
    uid: auth?.uid?.stringValue || undefined,
    token: auth?.token ? fromRulesFields(auth.token.mapValue ?? {}) : undefined,
    lines: frame.granularAllowOutcomes ?? [],
    rules: frame.rules ?? '',
    rulesHash: releaseKey.slice(releaseKey.lastIndexOf('-') + 1),
    before,
    after,
    changedKeys: method === 'update' ? changedKeys(before, after) : undefined,
    query:
      method === 'list'
        ? {
            limit:
              queryFields?.limit?.intValue !== undefined
                ? Number(queryFields.limit.intValue)
                : undefined,
            orderBy: (queryFields?.orderBy?.listValue?.values ?? []).flatMap((order) => {
              const field = order.mapValue?.fields?.field
              const name = field?.stringValue ?? field?.pathValue?.segments?.[0]?.simple
              return name ? [name] : []
            }),
          }
        : undefined,
    inTransaction: request.inTransaction?.boolValue === true,
    raw: frame,
  }
}

/**
 * A list's context path names the documents it may return — `users/*` —
 * which reads as a pattern; the collection it reads is the useful name.
 */
function listPath(path: string, method: string): string {
  return method === 'list' && path.endsWith('/*') ? path.slice(0, -2) : path
}

/** A list's collection, from the request's own path when the context's is not a document path. */
function queryPath(value: RulesTypedValue | undefined): string | undefined {
  const segments = value?.pathValue?.segments?.map((segment) => segment.simple ?? '')
  if (!segments) return undefined
  const at = segments.indexOf('documents')
  return at >= 0 ? segments.slice(at + 1).join('/') : segments.join('/')
}

/**
 * The rule lines that ran, each once, in the order they first ran, with how
 * many times: a query proof can run the same allow once per branch.
 */
export function linesRun(
  decision: Pick<RulesDecision, 'lines'>,
): Array<{ line: number; outcome: boolean; times: number }> {
  const out: Array<{ line: number; outcome: boolean; times: number }> = []
  for (const entry of decision.lines) {
    const known = out.find((item) => item.line === entry.line && item.outcome === entry.outcome)
    if (known) known.times += 1
    else out.push({ ...entry, times: 1 })
  }
  return out
}

/** The lines that decided the outcome: the allows that granted it, or for a denial every one that ran. */
export function decidingLines(decision: Pick<RulesDecision, 'lines' | 'outcome'>): number[] {
  const wanted = decision.outcome === 'allow'
  const lines = decision.lines.filter((line) => line.outcome === wanted).map((line) => line.line)
  return [...new Set(lines)]
}

export interface DecisionFilter {
  /** A path prefix: the path itself and everything under it. */
  path?: string | undefined
  uid?: string | undefined
  denied?: boolean | undefined
  /** Free text over the path, the uid and the method. */
  text?: string | undefined
}

export function filterDecisions(
  decisions: readonly RulesDecision[],
  database: string,
  filter: DecisionFilter,
): RulesDecision[] {
  const text = filter.text?.trim().toLowerCase()
  return decisions.filter((decision) => {
    if (decision.database !== database) return false
    if (filter.denied && decision.outcome === 'allow') return false
    if (filter.uid !== undefined && (decision.uid ?? '') !== filter.uid) return false
    if (
      filter.path &&
      decision.path !== filter.path &&
      !decision.path.startsWith(`${filter.path}/`)
    )
      return false
    if (
      text &&
      !decision.path.toLowerCase().includes(text) &&
      !(decision.uid ?? 'anonymous').toLowerCase().includes(text) &&
      !decision.method.includes(text)
    )
      return false
    return true
  })
}

const LIMIT = 500

interface DecisionsState {
  status: 'idle' | 'connecting' | 'live' | 'unavailable'
  decisions: RulesDecision[]
  detail: string | undefined
  push: (decision: RulesDecision) => void
  setStatus: (status: DecisionsState['status'], detail?: string) => void
  clear: () => void
}

export const useDecisions = create<DecisionsState>((set) => ({
  status: 'idle',
  decisions: [],
  detail: undefined,
  push: (decision) =>
    set((state) =>
      // A reconnect replays what the engine still holds; an id already
      // listed is the same decision, not a second one.
      state.decisions.some((known) => known.requestId === decision.requestId)
        ? state
        : { decisions: [decision, ...state.decisions].slice(0, LIMIT) },
    ),
  setStatus: (status, detail) => set({ status, detail }),
  clear: () => set({ decisions: [] }),
}))

/** Holds the feed open while the caller is mounted. */
export function useDecisionsFeed() {
  useEffect(() => {
    const store = useDecisions.getState()
    store.setStatus('connecting')
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(
      `${protocol}://${window.location.host}${API_BASE}/firestore/requests`,
    )
    socket.addEventListener('open', () => useDecisions.getState().setStatus('live'))
    socket.addEventListener('message', (message) => {
      // The engine sends history as one array, then each event alone.
      const text = String(message.data)
      let batch: unknown
      try {
        batch = JSON.parse(text)
      } catch {
        return
      }
      const frames = Array.isArray(batch) ? batch.map((item) => JSON.stringify(item)) : [text]
      // History arrives oldest first; each is pushed to the front.
      for (const frame of frames) {
        const decision = decodeDecision(frame)
        if (decision) useDecisions.getState().push(decision)
      }
    })
    socket.addEventListener('error', () =>
      useDecisions.getState().setStatus('unavailable', 'The decisions feed refused the connection'),
    )
    socket.addEventListener('close', (event) => {
      if (event.code !== 1000)
        useDecisions
          .getState()
          .setStatus('unavailable', event.reason || 'The decisions feed closed')
    })
    return () => {
      socket.close(1000)
      useDecisions.getState().setStatus('idle')
    }
  }, [])
}
