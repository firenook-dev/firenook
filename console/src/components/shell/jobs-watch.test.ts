import { describe, expect, it } from 'vitest'
import type { Job } from '@/lib/jobs'
import {
  UNSTOPPABLE_JOBS,
  jobEndToast,
  jobFailure,
  jobMark,
  jobProgress,
  jobToast,
  savedTo,
  shortPath,
} from './jobs-watch'

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

describe('how a job’s ending is said', () => {
  it('names the job and how it ended, keyed to replace its running toast', () => {
    expect(jobEndToast(job({ state: 'done', done: 5000 }))).toEqual({
      key: 'job:j1',
      title: 'Reset Firestore: done',
      description: '5,000 of 5,000',
      tone: 'success',
    })
    expect(jobEndToast(job({ state: 'cancelled' }))).toMatchObject({
      title: 'Reset Firestore: cancelled',
      tone: 'warning',
    })
    expect(jobEndToast(job({ state: 'failed', message: 'The engine stopped.' }))).toMatchObject({
      title: 'Reset Firestore: failed',
      description: 'The engine stopped.',
      tone: 'danger',
    })
  })

  it('says where a saved snapshot went, and copies the whole path', () => {
    const saved = job({
      kind: 'suite.export',
      title: "Save a snapshot to the project's export folder",
      total: 1,
      done: 1,
      state: 'done',
      result: {
        destination: 'project',
        path: '/work/app/firenook-export',
        targets: [],
        tookMs: 1_250,
      },
    })
    expect(savedTo(saved)).toEqual({ path: '/work/app/firenook-export', tookMs: 1_250 })
    expect(jobEndToast(saved)).toMatchObject({
      title: "Save a snapshot to the project's export folder: done",
      description: '/work/app/firenook-export · 1.3 s',
      action: { label: 'Copy path' },
    })
    expect(savedTo(job({ state: 'done', result: [{ section: 'firestore', removed: 3 }] }))).toBe(
      undefined,
    )
    expect(UNSTOPPABLE_JOBS.has('suite.export')).toBe(true)
    expect(UNSTOPPABLE_JOBS.has('suite.clear')).toBe(false)
  })

  it('keeps a long path’s end, which names the folder', () => {
    expect(shortPath('./export')).toBe('./export')
    expect(
      shortPath(
        '/var/folders/17/97zrc8dn5kj9m8sn51kc0h3w0000gn/T/firenook-console-x/firenook-export',
      ),
    ).toBe('…/T/firenook-console-x/firenook-export')
    expect(shortPath('/a/a-folder-name-so-long-that-it-fills-the-room-alone')).toBe(
      '…/a-folder-name-so-long-that-it-fills-the-room-alone',
    )
  })
})

describe('when a suite job is toasted', () => {
  it('follows a running job in a toast, with Cancel, on every page but the Overview', () => {
    const running = job({})
    expect(jobToast(running, undefined, false)).toMatchObject({
      key: 'job:j1',
      title: 'Reset Firestore',
      description: '1,204 of 5,000',
      tone: 'info',
      action: { label: 'Cancel' },
    })
    // The Overview's Reset card follows it there: shown once.
    expect(jobToast(running, undefined, true)).toBeUndefined()
    // Nothing moved since the last toast.
    expect(jobToast(running, jobMark(running), false)).toBeUndefined()
    // An export cannot be stopped.
    expect(jobToast(job({ kind: 'suite.export' }), undefined, false)?.action).toBeUndefined()
  })

  it('says how it ended everywhere, but not a job that was over before this tab saw it', () => {
    const running = job({})
    const done = job({ state: 'done', done: 5000 })
    expect(jobToast(done, jobMark(running), true)).toMatchObject({ title: 'Reset Firestore: done' })
    expect(jobToast(done, jobMark(running), false)).toMatchObject({
      title: 'Reset Firestore: done',
    })
    expect(jobToast(done, undefined, false)).toBeUndefined()
  })
})
