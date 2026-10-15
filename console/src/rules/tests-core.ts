// Saved requests with the verdict they should get: the rules' own tests.
// Kept per project and scope in this browser, run against the text in the
// editor every time it changes — so an edit that breaks one is red before
// it is applied — and exported as a `@firebase/rules-unit-testing` file for
// CI, which is where they belong once they matter.
//
// The store and the runner know nothing about what a request is: a page
// says how a saved form becomes a request and how its service evaluates a
// batch, and the cases, outcomes and runs are kept the same way for every
// page.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { type StoreApi, createStore, useStore } from 'zustand'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import { RulesCompileError } from './text'

/** What every saved case carries; a page adds the request form and anything its export needs. */
export interface TestCaseBase {
  id: string
  name: string
  expected: 'allow' | 'deny'
}

export interface TestOutcome<R extends { outcome: RulesOutcome }> {
  result?: R | undefined
  /** Why it could not run: a request the builder refused. */
  problem?: string | undefined
}

/** An error denies the request, in Firestore and in Storage, so it meets a "should deny". */
export function passes(
  test: Pick<TestCaseBase, 'expected'>,
  outcome: TestOutcome<{ outcome: RulesOutcome }> | undefined,
): boolean | undefined {
  if (!outcome?.result) return outcome?.problem ? false : undefined
  return (outcome.result.outcome === 'allow') === (test.expected === 'allow')
}

export interface TestsState<C extends TestCaseBase, R extends { outcome: RulesOutcome }> {
  key: string
  cases: C[]
  outcomes: Record<string, TestOutcome<R>>
  /** The rules text the outcomes are for. */
  ranSource: string | undefined
  running: boolean
  failure: string | undefined
  load: (key: string) => void
  add: (test: Omit<C, 'id'>) => void
  update: (id: string, patch: Partial<Omit<C, 'id'>>) => void
  remove: (id: string) => void
  setOutcomes: (source: string, outcomes: Record<string, TestOutcome<R>>) => void
  setRunning: (running: boolean, failure?: string) => void
}

/** A page's saved tests, outside React: components read it with `useStore`. */
export type TestsStore<C extends TestCaseBase, R extends { outcome: RulesOutcome }> = StoreApi<
  TestsState<C, R>
>

function read<C>(key: string, valid: (item: unknown) => boolean): C[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed.filter(valid) as C[]) : []
  } catch {
    return []
  }
}

function write(key: string, cases: unknown[]) {
  try {
    localStorage.setItem(key, JSON.stringify(cases))
  } catch {
    // Storage may be unavailable; the cases then last as long as the page.
  }
}

/**
 * A page's saved tests. `valid` says which stored items are cases (an item
 * left by another version of the page is dropped, not trusted).
 */
export function createTestsStore<C extends TestCaseBase, R extends { outcome: RulesOutcome }>(
  valid: (item: unknown) => boolean,
): TestsStore<C, R> {
  return createStore<TestsState<C, R>>((set, get) => {
    const save = (cases: C[]) => {
      set({ cases, ranSource: undefined })
      write(get().key, cases)
    }
    return {
      key: '',
      cases: [],
      outcomes: {},
      ranSource: undefined,
      running: false,
      failure: undefined,
      load: (key) => {
        if (get().key === key) return
        set({
          key,
          cases: read<C>(key, valid),
          outcomes: {},
          ranSource: undefined,
          failure: undefined,
        })
      },
      add: (test) => save([...get().cases, { ...test, id: crypto.randomUUID() } as C]),
      update: (id, patch) =>
        save(get().cases.map((test) => (test.id === id ? Object.assign({}, test, patch) : test))),
      remove: (id) => save(get().cases.filter((test) => test.id !== id)),
      setOutcomes: (source, outcomes) => set({ outcomes, ranSource: source }),
      setRunning: (running, failure) => set({ running, failure }),
    }
  })
}

/** The engine takes this many requests in one call. */
export const TEST_BATCH = 200

/** How a page runs its cases: each case's request, and its service's batch evaluation. */
export interface TestRunner<C extends TestCaseBase, Q, R extends { outcome: RulesOutcome }> {
  /** The request a case sends, or why it cannot be built. */
  build: (test: C) => { request: Q } | { error: string }
  /** Evaluate `requests` against `source`, in order. */
  evaluate: (requests: Q[], source: string) => Promise<{ results: R[] }>
}

/** Run every saved case against `source`, now. */
export async function runTests<C extends TestCaseBase, Q, R extends { outcome: RulesOutcome }>(
  store: TestsStore<C, R>,
  runner: TestRunner<C, Q, R>,
  source: string,
): Promise<void> {
  const state = store.getState()
  const cases = state.cases
  state.setRunning(true)
  const outcomes: Record<string, TestOutcome<R>> = {}
  const runnable: Array<{ id: string; request: Q }> = []
  for (const test of cases) {
    const built = runner.build(test)
    if ('error' in built) outcomes[test.id] = { problem: built.error }
    else runnable.push({ id: test.id, request: built.request })
  }
  try {
    const batches: Array<typeof runnable> = []
    for (let start = 0; start < runnable.length; start += TEST_BATCH)
      batches.push(runnable.slice(start, start + TEST_BATCH))
    const evaluations = await Promise.all(
      batches.map((slice) =>
        runner.evaluate(
          slice.map((item) => item.request),
          source,
        ),
      ),
    )
    batches.forEach((slice, batch) =>
      slice.forEach((item, index) => {
        outcomes[item.id] = { result: evaluations[batch]?.results[index] }
      }),
    )
    store.getState().setOutcomes(source, outcomes)
    store.getState().setRunning(false)
  } catch (error) {
    store
      .getState()
      .setRunning(
        false,
        error instanceof RulesCompileError
          ? 'The rules in the editor do not compile, so the tests cannot run.'
          : (error as Error).message,
      )
  }
}

/**
 * Keeps the saved cases of `key` loaded and run against the editor's text:
 * on arrival, and again shortly after each edit or each change to the cases.
 */
export function useTestRunner<C extends TestCaseBase, R extends { outcome: RulesOutcome }>(
  store: TestsStore<C, R>,
  key: string,
  source: string,
  ready: boolean,
  run: (source: string) => Promise<void>,
): void {
  const load = useStore(store, (state) => state.load)
  const cases = useStore(store, (state) => state.cases)
  // The latest runner, read when the timer fires: the cases, the text and
  // the scope decide when a run happens, not the runner's identity.
  const latest = useRef(run)
  useLayoutEffect(() => {
    latest.current = run
  })
  useEffect(() => load(key), [load, key])
  useEffect(() => {
    if (!ready || cases.length === 0) return
    const timer = window.setTimeout(() => void latest.current(source), 600)
    return () => window.clearTimeout(timer)
  }, [source, cases, ready])
}

/** How the saved cases fare against `source`; undefined until they have run on it. */
export function useTestSummary<C extends TestCaseBase, R extends { outcome: RulesOutcome }>(
  store: TestsStore<C, R>,
  source: string,
): { total: number; failing: number } | undefined {
  const cases = useStore(store, (state) => state.cases)
  const outcomes = useStore(store, (state) => state.outcomes)
  const ranSource = useStore(store, (state) => state.ranSource)
  if (cases.length === 0 || ranSource !== source) return undefined
  const failing = cases.filter((test) => passes(test, outcomes[test.id]) === false).length
  return { total: cases.length, failing }
}
