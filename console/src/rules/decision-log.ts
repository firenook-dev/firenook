// What a rules page keeps of the decisions its topic delivers —
// `firestore.decisions` or `storage.decisions`, one shape — and the words
// it says about them.
//
// Every filter is the topic's parameters (a path and what is under it, a
// uid, denials only, a method), which the engine evaluates on the replay and
// on the live tail, and the same values are the page's URL. So narrowing
// resubscribes, and nothing here filters a decision out in the browser: a
// list that says "12 decisions" is what the engine holds for that question.
//
// The topic resumes by replay. A new subscription (a new question, a tab
// shown again without a cursor) gets every decision the engine still holds
// that passes it, oldest first, then the live tail; a tab that was away so
// long the engine's ring moved past its cursor is told how many it missed,
// and the list says so where the gap is. The log keeps the newest 10,000,
// the engine's own window, newest first.

import { type StoreApi, createStore, useStore } from 'zustand'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import { type ClockFormat, formatClock, formatNumber } from '@/lib/format'
import { RULES_METHODS } from './search'

/** What both rules pages know of a decision from their topic. */
export interface RulesDecisionSummary {
  id: string
  /** When, RFC 3339. */
  at: string
  method: RulesMethod
  path: string
  outcome: RulesOutcome
  error: string | null
  uid: string | null
  tenant: string | null
  provider: string | null
  /** No credentials at all. */
  anonymous: boolean
  /** The allow statements it ran, in order. */
  allows: ReadonlyArray<{ line: number; outcome: RulesOutcome }>
  rulesHash: string
  viaConsole: boolean
}

/** What the engine still holds, as each topic's batch says. */
export interface DecisionWindow {
  retained: number
  since: string | null
  reRunnable: number
  omitted: number
}

/** One event of a decisions topic. */
export interface DecisionBatch<T> {
  items: T[]
  window: DecisionWindow
}

/** The decisions a page keeps: the engine's own window. */
export const DECISION_CAP = 10_000

/**
 * The filter field's terms as the topic's narrowing: `uid:<uid>`, a method
 * (`create`, or `method:create`), and a path — the first word that is
 * neither. Terms it does not know are part of no narrowing. Absent terms are
 * undefined, so the URL loses them.
 */
export function parseDecisionFilter(text: string): {
  path: string | undefined
  uid: string | undefined
  method: RulesMethod | undefined
} {
  let path: string | undefined
  let uid: string | undefined
  let method: RulesMethod | undefined
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const lower = word.toLowerCase()
    if (lower.startsWith('uid:')) {
      uid = word.slice(4) || undefined
      continue
    }
    const named = lower.startsWith('method:') ? lower.slice(7) : lower
    if ((RULES_METHODS as readonly string[]).includes(named)) {
      method = named as RulesMethod
      continue
    }
    if (path === undefined) path = word
  }
  return { path, uid, method }
}

/** A narrowing written back as the field's terms: the path, then `uid:`, then the method. */
export function printDecisionFilter(filters: {
  path?: string | undefined
  uid?: string | undefined
  method?: RulesMethod | undefined
}): string {
  return [filters.path, filters.uid ? `uid:${filters.uid}` : undefined, filters.method]
    .filter(Boolean)
    .join(' ')
}

export interface DecisionLogState<T> {
  /** Newest first, at most `DECISION_CAP`. */
  items: readonly T[]
  /**
   * Gaps the engine reported, keyed by the decision just older than each
   * (the list draws the gap above it); the count is how many were missed,
   * null when the engine could not say.
   */
  gaps: ReadonlyMap<string, number | null>
  /** What the engine still holds, from the latest batch. */
  window: DecisionWindow | undefined
  /** A batch has arrived since the log was last cleared. */
  heard: boolean
  /** The topic parameters the log answers, as JSON; null before any. */
  question: string | null
}

export interface DecisionLog<T> extends StoreApi<DecisionLogState<T>> {
  push: (batch: DecisionBatch<T>) => void
  /** The engine's ring moved past this subscription's cursor: `missed` were lost. */
  gap: (missed: number | null) => void
  clear: () => void
  /** The log is about `question` now: when it was about another, it starts again. */
  answer: (question: string | null) => void
}

/** A bounded, newest-first log of decisions, outside React. */
export function createDecisionLog<T extends { id: string }>(max = DECISION_CAP): DecisionLog<T> {
  const empty: DecisionLogState<T> = {
    items: [],
    gaps: new Map(),
    window: undefined,
    heard: false,
    question: null,
  }
  const store = createStore<DecisionLogState<T>>(() => empty)
  return Object.assign(store, {
    push(batch: DecisionBatch<T>) {
      const state = store.getState()
      const known = new Set(state.items.map((item) => item.id))
      const fresh: T[] = []
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
      store.setState({ ...empty, question: store.getState().question })
    },
    answer(question: string | null) {
      if (store.getState().question !== question) store.setState({ ...empty, question })
    },
  })
}

/** The log's state, for a component. */
export function useDecisionLog<T, S>(
  log: DecisionLog<T>,
  selector: (state: DecisionLogState<T>) => S,
): S {
  return useStore(log, selector)
}

/** The lines that decided a verdict: the allows that granted it, or for a refusal every one that ran. */
export function decidingLines(
  decision: Pick<RulesDecisionSummary, 'allows' | 'outcome'>,
): number[] {
  const allowed = decision.outcome === 'allow'
  return [
    ...new Set(
      decision.allows
        .filter((allow) => (allowed ? allow.outcome === 'allow' : allow.outcome !== 'allow'))
        .map((allow) => allow.line),
    ),
  ]
}

/** Who asked, in a few words: the uid (and tenant), or that nobody signed in. */
export function whoAsked(
  decision: Pick<RulesDecisionSummary, 'uid' | 'anonymous' | 'tenant'>,
): string {
  if (decision.uid === null) return decision.anonymous ? 'not signed in' : 'no uid'
  return decision.tenant ? `${decision.uid} · ${decision.tenant}` : decision.uid
}

/**
 * The footer under the list: what the engine still holds, in its words —
 * "Holding the last 10,000 decisions, since 09:12:04 · the newest 2,000 can
 * be re-run", and how many its feed missed when it fell behind.
 */
export function windowText(
  window: DecisionWindow | undefined,
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
