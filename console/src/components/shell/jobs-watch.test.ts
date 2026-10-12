import { describe, expect, it } from 'vitest'
import type { Job } from '@/lib/jobs'
import { jobFailure, jobProgress } from './jobs-watch'

const job = (overrides: Partial<Job>): Job => ({
  id: 'j1',
  kind: 'suite.clear',
  section: 'suite',
  title: 'Reset Firestore',
  total: 5000,
  done: 1204,
  skipped: 0,
  errors: [],
  errorCount: 0,
  state: 'running',
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: null,
  ...overrides,
})

describe('a job’s progress line', () => {
  it('says how far it got, and what it skipped or failed only when it did', () => {
    expect(jobProgress(job({}))).toBe('1,204 of 5,000')
    expect(jobProgress(job({ skipped: 3, errorCount: 2 }))).toBe(
      '1,204 of 5,000 · 3 skipped · 2 failed',
    )
    expect(jobProgress(job({ total: null, done: 7 }))).toBe('7 done')
  })
})

describe('why a job failed', () => {
  it('gives the engine’s reason for the job first, then the first failed item’s', () => {
    const failed = job({
      state: 'failed',
      errorCount: 1,
      errors: [{ key: 'users/u1', message: 'Permission denied.' }],
    })
    expect(jobFailure({ ...failed, message: 'The engine stopped.' })).toBe('The engine stopped.')
    expect(jobFailure(failed)).toBe('Permission denied.')
    expect(jobFailure(job({ state: 'failed' }))).toBe('1,204 of 5,000')
  })
})
