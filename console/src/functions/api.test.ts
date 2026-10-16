import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { triggersKey } from '@/lib/triggers'
import {
  clearInvocations,
  editEnv,
  functionKeys,
  getCodebaseLog,
  getFunction,
  getFunctions,
  getInvocation,
  getInvocations,
  invocationBodyUrl,
  matchTriggers,
  reloadCodebase,
  restartWorker,
  revealHeader,
  revealSecret,
} from './api'

interface Sent {
  url: string
  method: string
  headers: Headers
  body: unknown
}

let sent: Sent[]
let answer: { status: number; body?: unknown }

beforeEach(() => {
  sent = []
  answer = { status: 200, body: {} }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      if (answer.status === 204) return new Response(null, { status: 204 })
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const last = () => sent.at(-1) as Sent

describe('keys', () => {
  it('start with the section and the project, so the topic refreshes them by prefix', () => {
    const project = 'demo-x'
    for (const key of [
      functionKeys.snapshot(project),
      functionKeys.detail(project, 'us-central1-api'),
      functionKeys.invocationPage(project, 'outcome:failed'),
      functionKeys.invocation(project, 'a3f9c1-1'),
      functionKeys.codebaseLog(project, 'app'),
    ])
      expect(key.slice(0, 2)).toEqual(['functions', project])
    expect(functionKeys.invocationPage(project, '').slice(0, 3)).toEqual(
      functionKeys.invocations(project),
    )
    // Every section's trigger lines share lib/triggers' answers.
    expect(triggersKey(project, 'firestore', '(default)|a/b').slice(0, 3)).toEqual(
      functionKeys.triggers(project),
    )
  })
})

describe('reads', () => {
  it('ask the routes by path, with ids that hold any character', async () => {
    await getFunctions()
    expect(last().url).toBe('/console/api/v1/functions')
    await getFunction('us-central1-api')
    expect(last().url).toBe('/console/api/v1/functions/us-central1-api')
    await getInvocation('a3f9c1-12')
    expect(last().url).toBe('/console/api/v1/functions/invocations/a3f9c1-12')
    await getCodebaseLog('my codebase')
    expect(last().url).toBe('/console/api/v1/functions/codebases/my%20codebase/log')
    expect(last().headers.get('x-firenook-console')).toBe('1')
  })

  it('page invocations by filter and cursor, leaving out what is empty', async () => {
    await getInvocations({ q: '' })
    expect(last().url).toBe('/console/api/v1/functions/invocations')
    await getInvocations({ q: 'outcome:failed fn:api', cursor: 'c.1', limit: 200 })
    expect(last().url).toBe(
      '/console/api/v1/functions/invocations?q=outcome%3Afailed+fn%3Aapi&cursor=c.1&limit=200',
    )
  })

  it('reveal a header and a secret, answering the value alone', async () => {
    answer = { status: 200, body: { value: 'Bearer abc' } }
    expect(await revealHeader('a3f9c1-3', 'Authorization')).toBe('Bearer abc')
    expect(last().url).toBe('/console/api/v1/functions/invocations/a3f9c1-3/headers/Authorization')
    answer = { status: 200, body: { value: 's3cret' } }
    expect(await revealSecret('app', 'API_KEY')).toBe('s3cret')
    expect(last().url).toBe('/console/api/v1/functions/codebases/app/secrets/API_KEY')
  })

  it('link a recorded body for download', () => {
    expect(invocationBodyUrl('a3f9c1-4', 'response')).toBe(
      '/console/api/v1/functions/invocations/a3f9c1-4/body/response',
    )
  })

  it("throw the engine's error with its code and fix", async () => {
    answer = {
      status: 404,
      body: {
        error: {
          code: 'not-found',
          message: 'The engine no longer keeps invocation #1,284; it keeps the newest 2,000.',
        },
      },
    }
    const error = await getInvocation('a3f9c1-1284').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 404, code: 'not-found' })
  })
})

describe('changes', () => {
  it('post JSON with the console header', async () => {
    const request = {
      service: 'firestore',
      database: '(default)',
      path: 'orders/x',
      changes: ['created'],
    } as const
    answer = { status: 200, body: { matches: [], backgroundEnabled: true } }
    await matchTriggers({ ...request, changes: [...request.changes] })
    expect(last()).toMatchObject({ url: '/console/api/v1/functions/match', method: 'POST' })
    expect(last().headers.get('content-type')).toBe('application/json')
    expect(last().headers.get('x-firenook-console')).toBe('1')
    expect(last().body).toEqual({ ...request, changes: ['created'] })
  })

  it('edit env files, reload, restart and clear by codebase', async () => {
    answer = { status: 200, body: { written: ['.secret.local'], codebase: {} } }
    await editEnv('app', { changes: [{ file: 'secretLocal', key: 'MISSING_KEY', value: 'm1' }] })
    expect(last()).toMatchObject({
      url: '/console/api/v1/functions/codebases/app/edit-env',
      method: 'POST',
      body: { changes: [{ file: 'secretLocal', key: 'MISSING_KEY', value: 'm1' }] },
    })
    answer = { status: 202, body: {} }
    await reloadCodebase('app')
    expect(last()).toMatchObject({
      url: '/console/api/v1/functions/codebases/app/reload',
      body: {},
    })
    answer = { status: 200, body: { dropped: 2 } }
    expect(await restartWorker('app')).toEqual({ dropped: 2 })
    answer = { status: 204 }
    await clearInvocations()
    expect(last()).toMatchObject({
      url: '/console/api/v1/functions/invocations',
      method: 'DELETE',
      body: {},
    })
  })

  it('say when the engine refused, with the fix it gave', async () => {
    answer = {
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'The codebase app is still loading, so its worker cannot restart.',
          fix: 'Wait until it has loaded.',
        },
      },
    }
    const error = await restartWorker('app').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'conflict', fix: 'Wait until it has loaded.' })
  })
})
