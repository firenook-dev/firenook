import { describe, expect, it } from 'vitest'
import { codebase, snapshot, summary } from './fixtures.test-support'
import {
  ALL_NODE,
  discoveringText,
  functionMark,
  functionsTree,
  nodeTarget,
  openCodebases,
} from './functions-tree'

describe('the Functions panel tree', () => {
  const tree = functionsTree(
    snapshot(
      [
        summary('onOrder', 'firestore'),
        summary('api'),
        summary('legacyDb', 'database', {
          status: 'ignored',
          statusReason: 'no database emulator',
        }),
        summary('onUpload', 'storage', { status: 'noService' }),
        summary('busy', 'http', {
          stats: { runs: 3, failures: 0, inFlight: 2, last: null, p50Ms: null, p95Ms: null },
        }),
        summary('greet', 'http', { codebase: 'greeter', extensionInstance: 'greeter' }),
        summary('ping', 'http', { codebase: 'jobs' }),
      ],
      [
        codebase('greeter', { kind: 'extension', functionCount: 1 }),
        codebase('default', {
          functionCount: 5,
          notLoaded: [
            {
              id: 'us-central1-onConfig',
              eventType: 'remote.config',
              reason: 'remote.config is not emulated',
            },
          ],
        }),
        codebase('jobs', {
          state: 'failed',
          servingPrevious: true,
          functionCount: 1,
          error: { message: 'SyntaxError', detail: null, at: '2026-10-12T06:00:00.000Z' },
        }),
        codebase('slow', {
          state: 'loading',
          loadingSince: '2026-10-12T06:00:00.000Z',
          functionCount: 0,
        }),
      ],
    ),
    Date.parse('2026-10-12T06:00:01.400Z'),
  )

  it('lists every function first, then user codebases, then extension instances', () => {
    expect(tree.map((node) => node.label)).toEqual([
      'All functions',
      'default',
      'jobs',
      'slow',
      'greeter',
    ])
    expect(tree[0]).toMatchObject({ id: ALL_NODE, count: 7 })
  })

  it('sorts a codebase by name and lists what was not loaded last', () => {
    const fns = tree[1]?.children ?? []
    expect(fns.map((node) => node.label)).toEqual([
      'api',
      'busy',
      'legacyDb',
      'onOrder',
      'onUpload',
      'onConfig',
    ])
    expect(fns.at(-1)).toMatchObject({ count: 'not loaded', tone: 'warning' })
  })

  it('marks problems and running functions, and nothing else', () => {
    const marks = Object.fromEntries(
      (tree[1]?.children ?? []).map((node) => [node.label, [node.count, node.tone]]),
    )
    expect(marks.api).toEqual([undefined, undefined])
    expect(marks.busy).toEqual(['2 running', undefined])
    expect(marks.legacyDb).toEqual(['ignored', 'warning'])
    expect(marks.onUpload).toEqual(['no service', 'warning'])
    expect(functionMark(summary('gone', 'http', { status: 'removed' }))).toEqual({
      count: 'removed',
    })
    expect(functionMark(summary('quiet', 'http', { status: 'paused' }))).toEqual({
      count: 'paused',
      tone: 'warning',
    })
  })

  it('says a failed or loading codebase in its count', () => {
    expect(tree[2]).toMatchObject({ count: 'Failed · previous load', tone: 'danger' })
    expect(tree[3]?.count).toBe('Discovering… 1.4 s')
    expect(discoveringText(null, 0)).toBe('Discovering…')
  })

  it('opens what a node names', () => {
    expect(nodeTarget('all')).toEqual({ kind: 'all' })
    expect(nodeTarget('codebase:jobs')).toEqual({ kind: 'codebase', codebase: 'jobs' })
    expect(nodeTarget('function:us-central1-api')).toEqual({
      kind: 'function',
      id: 'us-central1-api',
    })
    expect(nodeTarget('not-loaded:default:us-central1-onConfig')).toEqual({
      kind: 'notLoaded',
      codebase: 'default',
      id: 'us-central1-onConfig',
    })
    expect([...openCodebases(snapshot([], [codebase('a'), codebase('b')]))]).toEqual([
      'codebase:a',
      'codebase:b',
    ])
  })
})
