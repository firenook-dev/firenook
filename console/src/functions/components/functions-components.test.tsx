import { describe, expect, it } from 'vitest'
import { codebase, invocation, summary } from '../fixtures.test-support'
import { exitWords, workerDown } from './codebase-banners'
import { diffText, workerWord } from './codebase-view'
import { SECRET_KEPT, byFile, changedFiles, envFileName } from './env-change-dialog'
import { envKeyProblem } from './environment-tab'
import { problemChips } from './function-toolbar'
import { noInvocationsText } from './function-workbench'
import { summaryParts } from './invocation-row'
import { sortOverview } from './overview'
import { overviewRows } from '../filters'
import { snapshot } from '../fixtures.test-support'
import { examplePath, fullTopic } from './trigger-tab'

const names = (sorted: ReturnType<typeof sortOverview>) =>
  sorted.map((row) => (row.kind === 'function' ? row.summary.name : `!${row.name}`))

describe('the Functions page pieces', () => {
  it('say how a worker stopped', () => {
    expect(exitWords('exited with code 1')).toBe('exited (code 1)')
    expect(exitWords('killed by signal SIGKILL')).toBe('exited (SIGKILL)')
    expect(exitWords(null)).toBe('exited')
    const exited = codebase('app', {
      worker: {
        ...codebase('app').codebase.worker,
        state: 'exited',
        lastExit: 'exited with code 1',
      },
    })
    expect(workerDown(exited)).toBe(true)
    expect(workerWord(exited)).toMatchObject({ word: 'Exited (code 1)', tone: 'warning' })
    const stopped = codebase('app', {
      worker: { ...codebase('app').codebase.worker, state: 'stopped' },
    })
    expect(workerDown(stopped)).toBe(false)
    expect(workerWord(stopped).word).toBe('Starts on the next call')
  })

  it("say a load's diff in words", () => {
    expect(diffText({ added: ['a'], changed: ['b', 'c'], removed: [] })).toBe('1 added, 2 changed')
    expect(diffText({ added: [], changed: [], removed: [] })).toBe('no function changes')
  })

  it('group an env change by file and name files a new value goes to', () => {
    expect(envFileName('envProject', 'demo-x')).toBe('.env.demo-x')
    expect(envFileName('secretLocal', 'demo-x')).toBe('.secret.local')
    const lines = byFile([
      { file: 'env', fileName: '.env', key: 'A', before: '1', after: '2', secret: false },
      {
        file: 'secretLocal',
        fileName: '.secret.local',
        key: 'S',
        before: null,
        after: 'x',
        secret: true,
      },
      { file: 'env', fileName: '.env', key: 'B', before: null, after: '3', secret: false },
    ])
    expect(lines.map(([file, changes]) => [file, changes.map((line) => line.key)])).toEqual([
      ['.env', ['A', 'B']],
      ['.secret.local', ['S']],
    ])
    // As the shared save dialog lists them: under the codebase's directory,
    // a secret's present value never held, a removal said as one.
    expect(
      changedFiles(
        [
          { file: 'env', fileName: '.env', key: 'A', before: '1', after: null, secret: false },
          {
            file: 'secretLocal',
            fileName: '.secret.local',
            key: 'S',
            before: SECRET_KEPT,
            after: 'x',
            secret: true,
          },
        ],
        'functions',
      ),
    ).toEqual([
      { file: 'functions/.env', changes: [{ key: 'A', before: '1', after: null, secret: false }] },
      {
        file: 'functions/.secret.local',
        changes: [{ key: 'S', before: null, after: 'x', secret: true }],
      },
    ])
    expect(
      changedFiles(
        lines.flatMap(([, changes]) => changes),
        undefined,
      )[0]?.file,
    ).toBe('.env')
    expect(envKeyProblem('GREETING')).toBeUndefined()
    expect(envKeyProblem('1BAD')).toMatch(/letters, digits/)
    expect(envKeyProblem('FIREBASE_CONFIG')).toMatch(/set by the emulator/)
  })

  it('chip only what is wrong', () => {
    expect(problemChips(summary('api'), codebase('default'))).toEqual([])
    const chips = problemChips(
      summary('usesSecret', 'http', {
        secrets: [
          { key: 'API_KEY', secret: 'API_KEY', provided: true },
          { key: 'MISSING_KEY', secret: 'MISSING_KEY', provided: false },
        ],
      }),
      codebase('default', {
        state: 'failed',
        servingPrevious: true,
        error: { message: 'boom', detail: null, at: '' },
      }),
    )
    expect(chips.map((chip) => chip.word)).toEqual([
      '1 secret missing',
      'Codebase failed · previous load',
    ])
  })

  it('tell an empty list how this function gets called', () => {
    expect(noInvocationsText(summary('api'), 'http://h:1/p/us-central1/api')).toBe(
      'Use Invoke on the right, or call http://h:1/p/us-central1/api from your app.',
    )
    expect(
      noInvocationsText(
        summary('onOrder', 'firestore', {
          trigger: { ...summary('x').trigger, document: 'orders/{id}' },
        }),
        undefined,
      ),
    ).toContain('write a document under orders/{id}')
  })

  it('split an HTTP summary into its method and the rest', () => {
    expect(
      summaryParts(
        invocation(1, {
          summary: 'POST /orders',
          cause: { type: 'http', method: 'POST', path: '/orders' },
        }),
      ),
    ).toEqual({
      method: 'POST',
      rest: '/orders',
    })
    expect(
      summaryParts(invocation(2, { summary: 'orders/o1 created', cause: { type: 'unknown' } })),
    ).toEqual({
      rest: 'orders/o1 created',
    })
  })

  it('order the overview with dropped functions last', () => {
    const rows = overviewRows(
      snapshot(
        [
          summary('b', 'http', {
            stats: { runs: 1, failures: 0, inFlight: 0, last: null, p50Ms: null, p95Ms: 3 },
          }),
          summary('a', 'http', {
            stats: { runs: 5, failures: 0, inFlight: 0, last: null, p50Ms: null, p95Ms: null },
          }),
        ],
        [
          codebase('default', {
            notLoaded: [{ id: 'us-central1-c', eventType: 'x', reason: 'x' }],
          }),
        ],
      ),
    )
    expect(names(sortOverview(rows, undefined))).toEqual(['a', 'b', '!c'])
    expect(names(sortOverview(rows, { column: 'runs', direction: 'desc' }))).toEqual([
      'a',
      'b',
      '!c',
    ])
    expect(names(sortOverview(rows, { column: 'p95', direction: 'asc' }))).toEqual(['b', 'a', '!c'])
  })

  it("start a matcher from the trigger's own pattern", () => {
    expect(examplePath('orders/{orderId}/items/{itemId}')).toBe('orders/orderId1/items/itemId1')
    expect(examplePath('logs/{rest=**}')).toBe('logs/rest1')
    expect(fullTopic('emails', 'demo-x')).toBe('projects/demo-x/topics/emails')
    expect(fullTopic('projects/other/topics/t', 'demo-x')).toBe('projects/other/topics/t')
  })
})
