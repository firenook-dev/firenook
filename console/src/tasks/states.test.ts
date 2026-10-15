import { describe, expect, it } from 'vitest'
import {
  attemptChip,
  attemptDetail,
  attemptText,
  countdownText,
  displayName,
  errorWord,
  executionText,
  lastResult,
  outcomeChip,
  stateTone,
  stateWord,
} from './states'
import { NOW, testAttempt, testRow } from './fixtures.test-support'

const at = (ms: number) => new Date(NOW + ms).toISOString()

describe('task states (U-16)', () => {
  it('say where a task is, with its place in the queue or its due time', () => {
    expect(stateWord(testRow({ state: 'pending', position: 3 }), NOW)).toBe('pending · #3')
    expect(stateWord(testRow({ state: 'pending', position: 1_204 }), NOW)).toBe('pending · #1,204')
    expect(
      stateWord(
        testRow({
          state: 'held',
          position: null,
          dueAt: new Date(NOW + 59 * 60_000).toISOString(),
        }),
        NOW,
      ),
    ).toBe('held · due in 59 min')
    expect(stateWord(testRow({ state: 'running', position: null }), NOW)).toBe('running')
    expect(stateWord(testRow({ state: 'backoff', position: null }), NOW)).toBe('backoff')
  })

  it('spend colour on a task waiting out a failure, nothing on what waits or runs', () => {
    expect(stateTone('running')).toBe('neutral')
    expect(stateTone('dispatching')).toBe('neutral')
    expect(stateTone('backoff')).toBe('warning')
    expect(stateTone('pending')).toBe('neutral')
    expect(stateTone('held')).toBe('neutral')
  })

  it('count down by whole seconds, and say now when it is due', () => {
    expect(countdownText(at(4_000), NOW)).toBe('in 4 s')
    expect(countdownText(at(3_200), NOW)).toBe('in 4 s')
    expect(countdownText(at(65_000), NOW)).toBe('in 1 min 5 s')
    expect(countdownText(at(0), NOW)).toBe('now')
    expect(countdownText(at(-2_000), NOW)).toBe('now')
  })

  it('write the attempt as n of max, with the off-by-one said in its tooltip', () => {
    expect(attemptText({ attempt: 2, maxRuns: 4 })).toBe('2 of 4')
    expect(attemptText({ attempt: 0, maxRuns: 4 })).toBe('—')
    expect(attemptText({ attempt: 7, maxRuns: null })).toBe('7')
    expect(attemptDetail(4)).toMatch(/maxAttempts \+ 1 times \(4 here\)/)
    expect(attemptDetail(null)).toMatch(/maxRetrySeconds/)
  })

  it('name a request that got no answer by what happened', () => {
    expect(
      errorWord(
        'FetchError: request to http://127.0.0.1:1/x failed, reason: connect ECONNREFUSED 127.0.0.1:1',
      ),
    ).toBe('refused')
    expect(errorWord('AbortError: The user aborted a request.')).toBe('timed out')
    expect(errorWord('TypeError: Only absolute URLs are supported')).toBe('invalid URL')
    expect(
      errorWord('FetchError: request to http://x failed, reason: getaddrinfo ENOTFOUND x'),
    ).toBe('no such host')
    expect(errorWord('something else')).toBe('failed')
  })

  it('show a status as data, success only for 2xx', () => {
    expect(lastResult(204, null)).toEqual({ word: '204', tone: 'success', mono: true })
    expect(lastResult(500, null)).toEqual({ word: '500', tone: 'danger', mono: true })
    expect(lastResult(404, null)?.tone).toBe('danger')
    expect(lastResult(null, 'AbortError: The user aborted a request.')).toMatchObject({
      word: 'timed out',
      tone: 'danger',
      mono: false,
    })
    expect(lastResult(null, null)).toBeNull()
    expect(attemptChip(testAttempt({ status: null, error: null })).word).toBe('no answer')
  })

  it('say whether an attempt counted as an execution, and why not', () => {
    expect(executionText(testAttempt({ countedExecution: true, status: 400 }))).toBe(
      'counted as an execution',
    )
    expect(executionText(testAttempt({ countedExecution: false, status: 500 }))).toBe(
      'not counted as an execution (5xx)',
    )
    expect(executionText(testAttempt({ countedExecution: false, status: null }))).toMatch(
      /no answer/,
    )
  })

  it('give each outcome its word and tone, and say what replaced means', () => {
    expect(outcomeChip('succeeded')).toMatchObject({ tone: 'success' })
    expect(outcomeChip('failed')).toMatchObject({ tone: 'danger' })
    expect(outcomeChip('cancelled').detail).toBe('You stopped its retries.')
    expect(outcomeChip('replaced').detail).toBe(
      'Dropped when the queue re-registered with new options.',
    )
  })

  it('shorten a generated name to the end of its number', () => {
    expect(displayName({ generated: true, shortName: '4503599627378812' })).toBe('auto·8812')
    expect(displayName({ generated: false, shortName: 'order-1' })).toBe('order-1')
  })
})
