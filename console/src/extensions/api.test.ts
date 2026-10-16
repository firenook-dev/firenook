import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import {
  ReconfigureRefused,
  extensionKeys,
  getInstance,
  getInstances,
  reconfigureInstance,
  reloadInstance,
  revealParam,
} from './api'
import { changedKeys } from './live'

let sent: Array<{ url: string; method: string; body: unknown; headers: Headers }>
let answer: { status: number; body: unknown }

beforeEach(() => {
  sent = []
  answer = { status: 200, body: {} }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
      })
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const last = () => sent.at(-1)

describe('the Extensions routes', () => {
  it('read instances, one instance and a secret', async () => {
    await getInstances()
    expect(last()?.url).toBe('/console/api/v1/extensions/instances')
    await getInstance('greeter')
    expect(last()?.url).toBe('/console/api/v1/extensions/instances/greeter')
    answer = { status: 200, body: { value: 'tok-123' } }
    expect(await revealParam('greeter', 'API_TOKEN')).toBe('tok-123')
    expect(last()?.url).toBe('/console/api/v1/extensions/instances/greeter/secrets/API_TOKEN')
  })

  it('reload an instance with a JSON body', async () => {
    await reloadInstance('greeter')
    expect(last()).toMatchObject({
      url: '/console/api/v1/extensions/instances/greeter/reload',
      method: 'POST',
      body: {},
    })
  })

  it('reconfigure writes values and secrets apart, and answers the files and the instance', async () => {
    answer = {
      status: 200,
      body: { written: ['extensions/greeter.env'], instance: { summary: {} } },
    }
    const result = await reconfigureInstance('greeter', {
      values: { GREETING_TEMPLATE: 'Hi, {name}' },
      secrets: {},
    })
    expect(result.written).toEqual(['extensions/greeter.env'])
    expect(last()).toMatchObject({
      url: '/console/api/v1/extensions/instances/greeter/reconfigure',
      method: 'POST',
      body: { values: { GREETING_TEMPLATE: 'Hi, {name}' }, secrets: {} },
    })
    expect(last()?.headers.get('x-firenook-console')).toBe('1')
    expect(last()?.headers.get('content-type')).toBe('application/json')
  })

  it('a refused reconfigure names every unacceptable value at once', async () => {
    answer = {
      status: 400,
      body: {
        error: { code: 'invalid-argument', message: '2 values are not acceptable.' },
        problems: [
          { param: 'LOCATION', message: 'mars is not one of the options.' },
          { param: 'BUCKET', message: 'BUCKET is required and has no value.' },
        ],
      },
    }
    const error = await reconfigureInstance('greeter', { values: {}, secrets: {} }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ReconfigureRefused)
    expect(error).toMatchObject({ code: 'invalid-argument', status: 400 })
    expect((error as ReconfigureRefused).problems.map((problem) => problem.param)).toEqual([
      'LOCATION',
      'BUCKET',
    ])
  })

  it('a configuration that does not load is a conflict with the load error, files put back', async () => {
    answer = {
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'greeter did not load with these values, so your files were put back.',
          fix: 'Unknown param reference ${param:NOPE}.',
        },
      },
    }
    const error = await reconfigureInstance('greeter', { values: {}, secrets: {} }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(ReconfigureRefused)
    expect(error).toMatchObject({ code: 'conflict', fix: 'Unknown param reference ${param:NOPE}.' })
  })
})

describe('extensions.changes', () => {
  it('names the list and each instance it changed', () => {
    expect(changedKeys('demo', { instanceIds: ['greeter', 'resize'] })).toEqual([
      extensionKeys.instances('demo'),
      ['extensions', 'demo', 'instance', 'greeter'],
      ['extensions', 'demo', 'instance', 'resize'],
    ])
  })
})
