// Storage's adapter for the rules kit's decisions panel: what the Storage
// rules decided, as the `storage.decisions` topic delivers it.
//
// Every filter is the topic's parameters — a folder or a file, a uid,
// denials only, a method — which the engine evaluates on the replay and on
// the live tail, and the same five values are the page's URL. So narrowing
// resubscribes, and nothing here filters a decision out in the browser: a
// list that says "12 decisions" is what the engine holds for that question.
//
// The topic resumes by replay. A new subscription (a new question, a tab
// shown again without a cursor) gets every decision the engine still holds
// that passes it, oldest first, then the live tail; a tab that was away so
// long the engine's ring moved past its cursor is told how many it missed,
// and the list says so where the gap is. The log here keeps the newest
// 10,000, the engine's own window, newest first.

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { type StoreApi, createStore, useStore } from 'zustand'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageDecisionBatch } from '@/api/generated/storage/StorageDecisionBatch'
import type { StorageDecisionWindow } from '@/api/generated/storage/StorageDecisionWindow'
import type { StorageDecisionsParams } from '@/api/generated/storage/StorageDecisionsParams'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { liveChannel } from '@/lib/live/channel'
import { formatClock, formatNumber, type ClockFormat } from '@/lib/format'
import { useStorageDecisionsLive } from '../live'
import { storageKeys } from '../queries'

/** The decisions a page keeps: the engine's own window. */
export const DECISION_CAP = 10_000

/** How the panel narrows the decisions, as the URL holds it. */
export interface DecisionFilters {
  path?: string | undefined
  uid?: string | undefined
  denied?: boolean | undefined
  method?: RulesMethod | undefined
}

/**
 * The topic's parameters for a narrowing: the scope's bucket (none when one
 * ruleset governs every bucket, which then lists every bucket's decisions),
 * a path as typed (a value ending in `/`, or empty, is a folder), a uid
 * exactly, denials only, one method. Absent filters are left out, so equal
 * questions are equal parameters.
 */
export function decisionParams(
  bucket: string | undefined,
  filters: DecisionFilters,
): StorageDecisionsParams {
  const params: StorageDecisionsParams = {}
  if (bucket !== undefined) params.bucket = bucket
  if (filters.path) params.path = filters.path
  if (filters.uid) params.uid = filters.uid
  if (filters.denied) params.denied = true
  if (filters.method) params.method = filters.method
  return params
}

export interface DecisionLogState {
  /** Newest first, at most `DECISION_CAP`. */
  items: readonly StorageDecision[]
  /**
   * Gaps the engine reported, keyed by the decision just older than each
   * (the list draws the gap above it); the count is how many were missed,
   * null when the engine could not say.
   */
  gaps: ReadonlyMap<string, number | null>
  /** What the engine still holds, from the latest batch. */
  window: StorageDecisionWindow | undefined
  /** A batch has arrived since the log was last cleared. */
  heard: boolean
  /** The topic parameters the log answers, as JSON; null before any. */
  question: string | null
}

export interface DecisionLog extends StoreApi<DecisionLogState> {
  push: (batch: StorageDecisionBatch) => void
  /** The engine's ring moved past this subscription's cursor: `missed` were lost. */
  gap: (missed: number | null) => void
  clear: () => void
  /** The log is about `question` now: when it was about another, it starts again. */
  answer: (question: string | null) => void
}

const EMPTY: DecisionLogState = {
  items: [],
  gaps: new Map(),
  window: undefined,
  heard: false,
  question: null,
}

/** A bounded, newest-first log of decisions, outside React. */
export function createDecisionLog(max = DECISION_CAP): DecisionLog {
  const store = createStore<DecisionLogState>(() => EMPTY)
  return Object.assign(store, {
    push(batch: StorageDecisionBatch) {
      const state = store.getState()
      const known = new Set(state.items.map((item) => item.id))
      const fresh: StorageDecision[] = []
      // A batch is oldest first; the log is newest first.
      for (let index = batch.items.length - 1; index >= 0; index -= 1) {
        const item = batch.items[index]
        if (item && !known.has(item.id)) {
          known.add(item.id)
          fresh.push(item)
        }
      }
      let items = fresh.length > 0 ? [...fresh, ...state.items] : state.items
      let gaps = state.gaps
      if (items.length > max) {
        items = items.slice(0, max)
        const kept = new Set(items.map((item) => item.id))
        if ([...gaps.keys()].some((key) => !kept.has(key)))
          gaps = new Map([...gaps].filter(([key]) => kept.has(key)))
      }
      store.setState({ items, gaps, window: batch.window, heard: true })
    },
    gap(missed: number | null) {
      const state = store.getState()
      const newest = state.items[0]
      // Nothing held yet: the replay that follows is everything there is.
      if (!newest) return
      const gaps = new Map(state.gaps)
      gaps.set(newest.id, missed)
      store.setState({ gaps })
    },
    clear() {
      store.setState({ ...EMPTY, question: store.getState().question })
    },
    answer(question: string | null) {
      if (store.getState().question !== question) store.setState({ ...EMPTY, question })
    },
  })
}

/**
 * Holds `storage.decisions` for the question `params` asks while mounted
 * (`null`: not now — decisions are off, or the panel is not shown) and keeps
 * the log it answers with. A new question starts the log again, and so does
 * a new engine run (its ids start again).
 */
export function useStorageDecisions(
  project: string,
  scope: string,
  params: StorageDecisionsParams | null,
): { log: DecisionLog; status: SubscriptionStatus } {
  const [log] = useState(() => createDecisionLog())
  const queryClient = useQueryClient()
  const question = params === null ? null : JSON.stringify(params)
  // Declared before the subscription, so the log is empty again before the
  // new question's replay can arrive (and after the old one stopped).
  useEffect(() => {
    log.answer(question)
  }, [log, question])
  useEffect(() => liveChannel.onEngineRestart(() => log.clear()), [log])
  const status = useStorageDecisionsLive(project, scope, params, {
    onDecisions: (batch) => log.push(batch),
    onReset: (_reason, missed) => {
      if (missed === null) log.clear()
      else log.gap(missed)
      void queryClient.invalidateQueries({ queryKey: storageKeys.rulesImpactOf(project, scope) })
    },
  })
  return { log, status }
}

/** The log's state, for a component. */
export function useDecisionLog<T>(log: DecisionLog, selector: (state: DecisionLogState) => T): T {
  return useStore(log, selector)
}

/** The lines that decided a verdict: the allows that granted it, or for a refusal every one that ran. */
export function decidingLines(decision: Pick<StorageDecision, 'allows' | 'outcome'>): number[] {
  const allowed = decision.outcome === 'allow'
  return [
    ...new Set(
      decision.allows
        .filter((allow) => (allowed ? allow.outcome === 'allow' : allow.outcome !== 'allow'))
        .map((allow) => allow.line),
    ),
  ]
}

/**
 * The footer under the list: what the engine still holds, in its words —
 * "Holding the last 10,000 decisions, since 09:12:04 · the newest 2,000 can
 * be re-run", and how many its feed missed when it fell behind.
 */
export function windowText(
  window: StorageDecisionWindow | undefined,
  clock: ClockFormat = 'time',
  now = Date.now(),
): string | undefined {
  if (!window || window.retained === 0) return undefined
  const held = `Holding the last ${formatNumber(window.retained)} ${window.retained === 1 ? 'decision' : 'decisions'}`
  const since = window.since ? `, since ${formatClock(window.since, clock, now)}` : ''
  const rerun =
    window.reRunnable >= window.retained
      ? window.retained === 1
        ? ' · it can be re-run'
        : ' · every one can be re-run'
      : ` · the newest ${formatNumber(window.reRunnable)} can be re-run`
  const omitted =
    window.omitted > 0
      ? ` · ${formatNumber(window.omitted)} were not recorded while the engine was busy`
      : ''
  return `${held}${since}${rerun}${omitted}`
}

/** What a gap row says. */
export function gapText(missed: number | null): string {
  return missed === null
    ? 'Some decisions were missed here: this tab was away longer than the engine keeps them.'
    : `${formatNumber(missed)} ${missed === 1 ? 'decision was' : 'decisions were'} missed here: this tab was away longer than the engine keeps them.`
}

/** What the detail says when the engine no longer keeps a decision's request. */
export const EVICTED =
  'The engine no longer keeps this decision’s request; it keeps the newest 2,000. Its verdict and lines are above. Try it in the playground.'

/** Who asked, in a few words: the uid (and tenant), or that nobody signed in. */
export function whoAsked(decision: Pick<StorageDecision, 'uid' | 'anonymous' | 'tenant'>): string {
  if (decision.uid === null) return decision.anonymous ? 'not signed in' : 'no uid'
  return decision.tenant ? `${decision.uid} · ${decision.tenant}` : decision.uid
}
