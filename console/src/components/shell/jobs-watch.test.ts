import { describe, expect, it } from 'vitest'
import type { Job } from '@/lib/jobs'
import { jobProgress } from './jobs-watch'

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
