import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import {
  TEST_BATCH,
  type TestCaseBase,
  type TestRunner,
  createTestsStore,
  passes,
  runTests,
  useTestRunner,
  useTestSummary,
} from './tests-core'
import { RulesCompileError } from './text'

interface Case extends TestCaseBase {
  form: { path: string }
}
interface Result {
  outcome: RulesOutcome
}

const isCase = (item: unknown) =>
  Boolean(item && typeof item === 'object' && (item as { form?: unknown }).form)

/** A runner whose rules allow paths under `public/` and refuse the rest. */
function runner(calls: string[][] = []): TestRunner<Case, string, Result> {
  return {
    build: (test) =>
      test.form.path === '' ? { error: 'Name the object.' } : { request: test.form.path },
    evaluate: async (requests) => {
      calls.push(requests)
      return {
        results: requests.map((path) => ({
          outcome: path.startsWith('public/') ? ('allow' as const) : ('deny' as const),
        })),
      }
    },
  }
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.useRealTimers())

describe('whether a saved test passes', () => {
  it('compares allow with allow, and counts an error as a deny', () => {
    expect(passes({ expected: 'allow' }, { result: { outcome: 'allow' } })).toBe(true)
    expect(passes({ expected: 'deny' }, { result: { outcome: 'error' } })).toBe(true)
    expect(passes({ expected: 'allow' }, { result: { outcome: 'deny' } })).toBe(false)
  })

  it('fails a test that could not run, and says nothing before it ran', () => {
    expect(passes({ expected: 'deny' }, { problem: 'Name the object.' })).toBe(false)
    expect(passes({ expected: 'deny' }, undefined)).toBeUndefined()
  })
})

describe('the saved tests of one scope', () => {
  it('are kept in this browser per key, and only items that are cases come back', () => {
    const store = createTestsStore<Case, Result>(isCase)
    store.getState().load('firenook.console.storage-rules-tests.demo.b')
    store.getState().add({ name: 'avatar', form: { path: 'users/u1/a.png' }, expected: 'deny' })
    const [saved] = store.getState().cases
    expect(saved?.id).toBeTruthy()
    store.getState().update(saved?.id ?? '', { expected: 'allow' })
    localStorage.setItem(
      'firenook.console.storage-rules-tests.demo.other',
      JSON.stringify([
        { name: 'not a case' },
        { id: 'x', name: 'n', form: { path: 'p' }, expected: 'allow' },
      ]),
    )

    const again = createTestsStore<Case, Result>(isCase)
    again.getState().load('firenook.console.storage-rules-tests.demo.b')
    expect(again.getState().cases).toEqual([
      { id: saved?.id, name: 'avatar', form: { path: 'users/u1/a.png' }, expected: 'allow' },
    ])
    again.getState().load('firenook.console.storage-rules-tests.demo.other')
    expect(again.getState().cases.map((test) => test.id)).toEqual(['x'])
    again.getState().remove('x')
    expect(
      JSON.parse(localStorage.getItem('firenook.console.storage-rules-tests.demo.other') ?? ''),
    ).toEqual([])
  })

  it('run against a text in batches the engine takes, a case that cannot be built failing alone', async () => {
    const store = createTestsStore<Case, Result>(isCase)
    store.getState().load('k')
    const cases: Case[] = Array.from({ length: TEST_BATCH + 5 }, (_, index) => ({
      id: `t${index}`,
      name: `t${index}`,
      form: { path: index === 3 ? '' : `public/${index}` },
      expected: 'allow',
    }))
    store.setState({ cases })
    const calls: string[][] = []
    await runTests(store, runner(calls), 'rules text')
    expect(calls.map((batch) => batch.length)).toEqual([TEST_BATCH, 4])
    const state = store.getState()
    expect(state.ranSource).toBe('rules text')
    expect(state.running).toBe(false)
    expect(state.outcomes.t3).toEqual({ problem: 'Name the object.' })
    expect(state.outcomes.t204?.result?.outcome).toBe('allow')
  })

  it('say the draft does not compile instead of failing each test', async () => {
    const store = createTestsStore<Case, Result>(isCase)
    store.getState().load('k')
    store.getState().add({ name: 'a', form: { path: 'public/a' }, expected: 'allow' })
    await runTests(
      store,
      {
        ...runner(),
        evaluate: () => Promise.reject(new RulesCompileError('does not compile', [])),
      },
      'broken',
    )
    expect(store.getState().failure).toBe(
      'The rules in the editor do not compile, so the tests cannot run.',
    )
  })

  it('run again shortly after the text changes, and are summed up for that text only', async () => {
    vi.useFakeTimers()
    const store = createTestsStore<Case, Result>(isCase)
    store.getState().load('k')
    store.getState().add({ name: 'a', form: { path: 'users/a' }, expected: 'allow' })
    const run = vi.fn((source: string) => runTests(store, runner(), source))
    const { result, rerender } = renderHook(
      ({ source }) => {
        useTestRunner(store, 'k', source, true, run)
        return useTestSummary(store, source)
      },
      { initialProps: { source: 'v1' } },
    )
    expect(result.current).toBeUndefined()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(run).toHaveBeenCalledWith('v1')
    expect(result.current).toEqual({ total: 1, failing: 1 })
    rerender({ source: 'v2' })
    expect(result.current).toBeUndefined()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(run).toHaveBeenLastCalledWith('v2')
    expect(run).toHaveBeenCalledTimes(2)
  })
})
