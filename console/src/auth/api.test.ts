import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import {
  AuthEmulatorError,
  batchGetUsers,
  callAuthEmulator,
  emulatorPath,
  emulatorUrl,
  errorCode,
  exportUsersHref,
  getActivity,
  getUsers,
  previewBulk,
  startBulk,
  tenantsPath,
  toolkitPath,
  updateEmulatorConfig,
  uploadImport,
} from './api'

interface Sent {
  url: URL
  init: RequestInit
}

let sent: Sent[]
let reply: (sent: Sent) => Response

beforeEach(() => {
  sent = []
  reply = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
    const one = { url: new URL(input, 'http://console.test'), init }
    sent.push(one)
    return Promise.resolve(reply(one))
  })
})

afterEach(() => vi.unstubAllGlobals())

const header = (one: Sent | undefined, name: string) => new Headers(one?.init.headers).get(name)

describe('the Console API', () => {
  it('sends the project and the page params, and leaves out what is empty', async () => {
    await getUsers('demo-auth', { tenant: 'acme', q: '', sort: 'email:asc', limit: 100 })
    expect(sent[0]?.url.pathname).toBe('/console/api/v1/auth/users')
    expect(Object.fromEntries(sent[0]?.url.searchParams ?? [])).toEqual({
      project: 'demo-auth',
      tenant: 'acme',
      sort: 'email:asc',
      limit: '100',
    })
    await getActivity('', { q: 'is:error', console: false })
    expect(Object.fromEntries(sent[1]?.url.searchParams ?? [])).toEqual({ q: 'is:error' })
  })

  it('reads rows again with the scope in the address and the window in the body', async () => {
    await batchGetUsers('demo-auth', undefined, { keys: ['u_1'], pageStarts: [null] })
    expect(sent[0]?.init.method).toBe('POST')
    expect(sent[0]?.url.pathname).toBe('/console/api/v1/auth/users:batchGet')
    expect(sent[0]?.url.search).toBe('?project=demo-auth')
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ keys: ['u_1'], pageStarts: [null] })
  })

  it('runs a bulk change as a dry run first, then as a job, each saying which it is', async () => {
    const target = { by: 'query' as const, q: 'is:sample', scope: {} }
    await previewBulk('demo-auth', 'delete', { target, triggers: false })
    await startBulk('demo-auth', 'delete', { target, triggers: false })
    expect(sent.map((one) => one.url.pathname)).toEqual([
      '/console/api/v1/auth/users:delete',
      '/console/api/v1/auth/users:delete',
    ])
    expect(sent.map((one) => JSON.parse(String(one.init.body)).dryRun)).toEqual([true, false])
  })

  it('uploads an import as the file itself, as JSON, with the console header', async () => {
    const file = new Blob(['{"users":[]}'], { type: 'application/json' })
    reply = () =>
      new Response(JSON.stringify({ importId: 'imp-1', total: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const preview = await uploadImport('demo-auth', 'acme', file)
    expect(preview.importId).toBe('imp-1')
    expect(sent[0]?.url.pathname).toBe('/console/api/v1/auth/imports')
    expect(sent[0]?.url.search).toBe('?project=demo-auth&tenant=acme')
    expect(sent[0]?.init.body).toBe(file)
    expect(header(sent[0], 'content-type')).toBe('application/json')
    expect(header(sent[0], 'x-firenook-console')).toBe('1')
  })

  it('says an engine refusal as an ApiError with its code and fix', async () => {
    reply = () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'not-found',
            message: 'There is no tenant `acme` in this project.',
            fix: 'Pick a tenant from the list, or create it in Settings.',
          },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )
    const error = await getUsers('demo-auth', { tenant: 'acme' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      code: 'not-found',
      fix: 'Pick a tenant from the list, or create it in Settings.',
    })
  })

  it('builds an export as a streamed address: a filter, or up to 500 users by uid', () => {
    expect(exportUsersHref('demo-auth', { format: 'json', q: 'is:disabled', tenant: 'acme' })).toBe(
      '/console/api/v1/auth/users:export?project=demo-auth&tenant=acme&format=json&q=is%3Adisabled',
    )
    expect(exportUsersHref('', { format: 'csv', q: 'ignored', uids: ['u/1', 'u|2'] })).toBe(
      '/console/api/v1/auth/users:export?format=csv&uid=u%2F1&uid=u%7C2',
    )
  })
})

describe('the Auth emulator through the mount', () => {
  it('spells official paths as the SDKs do', () => {
    expect(toolkitPath('accounts:signUp')).toBe(
      '/identitytoolkit.googleapis.com/v1/accounts:signUp',
    )
    expect(toolkitPath('accounts:update', { project: 'demo-auth', tenant: 'acme' })).toBe(
      '/identitytoolkit.googleapis.com/v1/projects/demo-auth/tenants/acme/accounts:update',
    )
    expect(tenantsPath('demo-auth', 'acme')).toBe(
      '/identitytoolkit.googleapis.com/v2/projects/demo-auth/tenants/acme',
    )
    expect(emulatorPath('demo-auth', 'config')).toBe('/emulator/v1/projects/demo-auth/config')
    expect(emulatorUrl({ path: toolkitPath('accounts:signUp'), as: 'client' })).toBe(
      '/console/api/v1/auth/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key',
    )
    expect(
      emulatorUrl({
        path: '/securetoken.googleapis.com/v1/token',
        query: { key: 'k' },
        as: 'client',
      }),
    ).toBe('/console/api/v1/auth/securetoken.googleapis.com/v1/token?key=k')
  })

  it('calls as the Admin SDK with the owner credential and reads the call id back', async () => {
    reply = () =>
      new Response(JSON.stringify({ localId: 'u_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-firenook-activity': '41' },
      })
    const answer = await callAuthEmulator<{ localId: string }>({
      method: 'POST',
      path: toolkitPath('accounts', { project: 'demo-auth' }),
      body: { email: 'ada@example.test' },
      as: 'admin',
      origin: 'write',
      headers: { authorization: 'Bearer stolen', 'x-client-version': 'Chrome/JsCore/11.0.0' },
    })
    expect(answer).toEqual({ status: 200, body: { localId: 'u_1' }, activity: 41 })
    expect(header(sent[0], 'authorization')).toBe('Bearer owner')
    expect(header(sent[0], 'x-firenook-console')).toBe('write')
    expect(header(sent[0], 'x-client-version')).toBe('Chrome/JsCore/11.0.0')
    expect(header(sent[0], 'content-type')).toBe('application/json')
  })

  it('calls as a client with the API key and no credential', async () => {
    await callAuthEmulator({
      method: 'POST',
      path: toolkitPath('accounts:signInWithPassword'),
      body: { email: 'ada@example.test', password: 'password-1' },
      as: 'client',
      origin: 'try',
    })
    expect(sent[0]?.url.searchParams.get('key')).toBe('fake-api-key')
    expect(header(sent[0], 'authorization')).toBeNull()
    expect(header(sent[0], 'x-firenook-console')).toBe('try')
  })

  it('says a refusal with the emulator’s own code and the call it was', async () => {
    reply = () =>
      new Response(
        JSON.stringify({
          error: { code: 400, message: 'WEAK_PASSWORD : Password should be at least 6 characters' },
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json', 'x-firenook-activity': '7' },
        },
      )
    const error = await callAuthEmulator({
      method: 'POST',
      path: toolkitPath('accounts:signUp'),
      body: {},
      as: 'client',
      origin: 'try',
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AuthEmulatorError)
    expect(error).toMatchObject({
      status: 400,
      code: 'WEAK_PASSWORD',
      activity: 7,
      message: 'WEAK_PASSWORD : Password should be at least 6 characters',
    })
  })

  it('reads a code from the message, or from the status when the message is prose', () => {
    expect(errorCode('INVALID_LOGIN_CREDENTIALS')).toBe('INVALID_LOGIN_CREDENTIALS')
    expect(errorCode('FORBIDDEN_CLAIM : iss')).toBe('FORBIDDEN_CLAIM')
    expect(
      errorCode('Request contains an invalid argument.', {
        error: { message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' },
      }),
    ).toBe('INVALID_ARGUMENT')
    expect(errorCode('Something else went wrong.')).toBe('Something else went wrong.')
  })

  it('changes the project switches through the official route', async () => {
    reply = () =>
      new Response(
        JSON.stringify({
          signIn: { allowDuplicateEmails: true },
          emailPrivacyConfig: { enableImprovedEmailPrivacy: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const config = await updateEmulatorConfig('demo-auth', { allowDuplicateEmails: true })
    expect(config.signIn.allowDuplicateEmails).toBe(true)
    expect(sent[0]?.init.method).toBe('PATCH')
    expect(sent[0]?.url.pathname).toBe('/console/api/v1/auth/emulator/v1/projects/demo-auth/config')
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      signIn: { allowDuplicateEmails: true },
    })
  })

  it('says the engine did not answer as a network error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    const error = await callAuthEmulator({
      method: 'GET',
      path: emulatorPath('demo-auth', 'config'),
      as: 'admin',
      origin: 'write',
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'network', status: 0 })
  })
})
