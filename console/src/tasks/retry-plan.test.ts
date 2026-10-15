import { describe, expect, it } from 'vitest'
import { pad } from '@/lib/format'
import {
  PLAN_LIMIT,
  ladderText,
  ladderTotal,
  maxAttemptsNote,
  omittedText,
  planIsCut,
  planRows,
  secondsText,
} from './retry-plan'
import { testQueue } from './fixtures.test-support'

const at = (iso: string) => {
  const date = new Date(iso)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

describe('the retry plan (U-13)', () => {
  it('lists each remaining attempt at its earliest time with the backoff before it', () => {
    const rows = planRows([
      { attempt: 3, earliestAt: '2026-10-12T10:02:31.000Z', backoffSeconds: 4, last: false },
      { attempt: 4, earliestAt: '2026-10-12T10:02:39.000Z', backoffSeconds: 8, last: true },
    ])
    expect(rows).toEqual([
      { attempt: 3, at: at('2026-10-12T10:02:31.000Z'), backoff: '+4 s', last: false },
      { attempt: 4, at: at('2026-10-12T10:02:39.000Z'), backoff: '+8 s', last: true },
    ])
    expect(
      planRows([
        { attempt: 1, earliestAt: '2026-10-12T10:02:27.000Z', backoffSeconds: 0, last: false },
      ])[0]?.backoff,
    ).toBe('')
  })

  it('writes the ladder of a queue with its total, last rung marked', () => {
    const { ladder } = testQueue().config
    expect(ladderText(ladder)).toBe('1 → now · 2 → +1 s · 3 → +2 s · 4 → +4 s (last)')
    expect(ladderTotal(ladder)).toBe('7 s')
  })

  it('says when the engine stopped planning before the dispatcher would stop', () => {
    const endless = Array.from({ length: PLAN_LIMIT }, (_, index) => ({
      attempt: index + 1,
      backoffSeconds: index === 0 ? 0 : 1,
      afterSeconds: index,
      last: false,
    }))
    expect(planIsCut(endless)).toBe(true)
    expect(ladderText(endless).endsWith(' · …')).toBe(true)
    expect(ladderTotal(endless)).toBe('49 s and on')
    expect(planIsCut(testQueue().config.ladder)).toBe(false)
  })

  it('counts the attempts in between that were not kept', () => {
    expect(omittedText(12)).toBe('12 attempts in between not kept')
    expect(omittedText(1)).toBe('1 attempt in between not kept')
  })

  it('states the off-by-one honestly, and what maxRetrySeconds does instead', () => {
    expect(maxAttemptsNote({ maxAttempts: 3, maxRetrySeconds: null })).toBe(
      'maxAttempts 3 runs a failing task 4 times: the emulator checks the limit before counting the attempt, as the official emulator does.',
    )
    expect(maxAttemptsNote({ maxAttempts: 0, maxRetrySeconds: 0 })).toMatch(
      /runs a failing task 1 times/,
    )
    expect(maxAttemptsNote({ maxAttempts: 1, maxRetrySeconds: 2 })).toMatch(
      /keeps a failing task retrying past maxAttempts 1 until that long/,
    )
    expect(maxAttemptsNote({ maxAttempts: -1, maxRetrySeconds: null })).toMatch(
      /after its first attempt/,
    )
  })

  it('writes seconds the way the config holds them', () => {
    expect(secondsText(0.1)).toBe('0.1 s')
    expect(secondsText(4)).toBe('4 s')
    expect(secondsText(65)).toBe('1 min 5 s')
    expect(secondsText(3600)).toBe('1 h')
  })
})
