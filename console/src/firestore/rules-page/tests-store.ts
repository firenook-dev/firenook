// Saved requests with the verdict they should get: the rules' own tests.
// Kept per project and database in this browser, run against the text in
// the editor every time it changes — so an edit that breaks one is red
// before it is applied — and exported as a `@firebase/rules-unit-testing`
// file for CI, which is where they belong once they matter.

import { useEffect } from 'react'
import { create } from 'zustand'
import { evaluateRules } from './api'
import type { EvaluateResult } from '@/api/generated/EvaluateResult'
import type { FirestoreRestValue } from '@/api/generated/FirestoreRestValue'
import { RulesCompileError } from '../rules'
import { type PlaygroundForm, toEvaluateRequest } from './requests'

export interface TestCase {
  id: string
  name: string
  form: PlaygroundForm
  expected: 'allow' | 'deny'
  /** The document as it was when the case was saved, for an exported test to set up. */
  seed?: Record<string, FirestoreRestValue> | null | undefined
}

export interface TestOutcome {
  result?: EvaluateResult | undefined
  /** Why it could not run: a request the builder refused. */
  problem?: string | undefined
}

/** An error denies the request in Firestore, so it meets a "should deny". */
export function passes(test: TestCase, outcome: TestOutcome | undefined): boolean | undefined {
  if (!outcome?.result) return outcome?.problem ? false : undefined
  return (outcome.result.outcome === 'allow') === (test.expected === 'allow')
}

interface TestsState {
  key: string
  cases: TestCase[]
  outcomes: Record<string, TestOutcome>
  /** The rules text the outcomes are for. */
  ranSource: string | undefined
  running: boolean
  failure: string | undefined
  load: (key: string) => void
  add: (test: Omit<TestCase, 'id'>) => void
  update: (id: string, patch: Partial<Omit<TestCase, 'id'>>) => void
  remove: (id: string) => void
  replaceAll: (cases: TestCase[]) => void
  setOutcomes: (source: string, outcomes: Record<string, TestOutcome>) => void
  setRunning: (running: boolean, failure?: string) => void
}

function read(key: string): TestCase[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TestCase[]).filter((item) => item && item.form) : []
  } catch {
    return []
  }
}

function write(key: string, cases: TestCase[]) {
  try {
    localStorage.setItem(key, JSON.stringify(cases))
  } catch {
    // Storage may be unavailable; the cases then last as long as the page.
  }
}

export function testsKey(project: string, database: string): string {
  return `firenook.console.rules-tests.${project}.${database}`
}

export const useTests = create<TestsState>((set, get) => {
  const save = (cases: TestCase[]) => {
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
      set({ key, cases: read(key), outcomes: {}, ranSource: undefined, failure: undefined })
    },
    add: (test) => save([...get().cases, { ...test, id: crypto.randomUUID() }]),
    update: (id, patch) =>
      save(get().cases.map((test) => (test.id === id ? Object.assign({}, test, patch) : test))),
    remove: (id) => save(get().cases.filter((test) => test.id !== id)),
    replaceAll: (cases) => save(cases),
    setOutcomes: (source, outcomes) => set({ outcomes, ranSource: source }),
    setRunning: (running, failure) => set({ running, failure }),
  }
})

/** The engine takes this many requests in one call. */
const BATCH = 200

/** Run every saved case against `source`, now. */
export async function runTests(project: string, database: string, source: string) {
  const state = useTests.getState()
  const cases = state.cases
  state.setRunning(true)
  const outcomes: Record<string, TestOutcome> = {}
  const runnable: Array<{ id: string; request: ReturnType<typeof toEvaluateRequest> }> = []
  for (const test of cases) {
    const built = toEvaluateRequest(test.form, project, database)
    if ('error' in built) outcomes[test.id] = { problem: built.error }
    else runnable.push({ id: test.id, request: built })
  }
  try {
    const batches: Array<typeof runnable> = []
    for (let start = 0; start < runnable.length; start += BATCH)
      batches.push(runnable.slice(start, start + BATCH))
    const evaluations = await Promise.all(
      batches.map((slice) =>
        evaluateRules(
          database,
          slice.flatMap((item) => ('request' in item.request ? [item.request.request] : [])),
          source,
        ),
      ),
    )
    batches.forEach((slice, batch) =>
      slice.forEach((item, index) => {
        outcomes[item.id] = { result: evaluations[batch]?.results[index] }
      }),
    )
    useTests.getState().setOutcomes(source, outcomes)
    useTests.getState().setRunning(false)
  } catch (error) {
    useTests
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
 * Keeps the saved cases loaded and run against the editor's text: on
 * arrival, and again shortly after each edit or each change to the cases.
 */
export function useTestRunner(project: string, database: string, source: string, ready: boolean) {
  const load = useTests((state) => state.load)
  const cases = useTests((state) => state.cases)
  useEffect(() => load(testsKey(project, database)), [load, project, database])
  useEffect(() => {
    if (!ready || cases.length === 0) return
    const timer = window.setTimeout(() => void runTests(project, database, source), 600)
    return () => window.clearTimeout(timer)
  }, [project, database, source, cases, ready])
}

/** How the saved cases fare against `source`; undefined until they have run on it. */
export function useTestSummary(source: string): { total: number; failing: number } | undefined {
  const cases = useTests((state) => state.cases)
  const outcomes = useTests((state) => state.outcomes)
  const ranSource = useTests((state) => state.ranSource)
  if (cases.length === 0 || ranSource !== source) return undefined
  const failing = cases.filter((test) => passes(test, outcomes[test.id]) === false).length
  return { total: cases.length, failing }
}
