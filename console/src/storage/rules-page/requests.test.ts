import { describe, expect, it } from 'vitest'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import type { StorageRulesObjectView } from '@/api/generated/storage/StorageRulesObjectView'
import { patchForm } from './playground-store'
import {
  EMPTY_FORM,
  type PlaygroundForm,
  describeForm,
  formFromDecision,
  formFromRequest,
  metadataOf,
  pathProblem,
  sizeFields,
  toBytes,
  toEvaluateRequest,
  tokenWho,
} from './requests'

const BUCKET = 'demo.appspot.com'

/** The JSON a minted token carries, read back. */
function claimsOf(authorization: string | null | undefined): Record<string, unknown> {
  const payload = (authorization ?? '').split(' ')[1]?.split('.')[1] ?? ''
  const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))))
}

/** An unsigned ID token with `claims`: UTF-8, base64url, unpadded, as a JWT writes them. */
function token(claims: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(claims))
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${btoa('{}')}.${body}.`
}

const form = (patch: Partial<PlaygroundForm>): PlaygroundForm => ({ ...EMPTY_FORM, ...patch })

const row = (key: string, value: string) => ({ id: key, key, value, enabled: true })

const OBJECT: StorageRulesObjectView = {
  name: 'users/u1/a.png',
  bucket: BUCKET,
  size: 2048,
  contentType: 'image/png',
  contentDisposition: null,
  contentEncoding: null,
  metadata: { ownerUid: 'u1' },
  generation: '3',
  metageneration: '1',
  timeCreated: '2026-10-12T09:00:00Z',
  updated: '2026-10-12T09:00:00Z',
  md5Hash: 'x',
  crc32c: 'y',
  etag: 'z',
}

describe('sizes', () => {
  it('reads a size in its unit as bytes, the binary way rules count them', () => {
    expect(toBytes('7', 'MB')).toBe(7_340_032)
    expect(toBytes('1.5', 'KB')).toBe(1536)
    expect(toBytes('0', 'B')).toBe(0)
    expect(toBytes('', 'MB')).toBeUndefined()
    expect(toBytes('7 MB', 'MB')).toBeUndefined()
    expect(toBytes('-1', 'B')).toBeUndefined()
  })

  it('writes bytes in the largest unit they are a whole number of', () => {
    expect(sizeFields(7_340_032)).toEqual({ size: '7', unit: 'MB' })
    expect(sizeFields(2 * 1024 ** 3)).toEqual({ size: '2', unit: 'GB' })
    expect(sizeFields(1536)).toEqual({ size: '1536', unit: 'B' })
    expect(sizeFields(0)).toEqual({ size: '0', unit: 'B' })
  })
})

describe('the playground’s form as the request the engine evaluates', () => {
  it('names a file for get, update and delete, and a folder for list', () => {
    expect(pathProblem('get', '')).toMatch(/Name the file/)
    expect(pathProblem('delete', 'users/')).toMatch(/choose list/)
    expect(pathProblem('list', '')).toBeUndefined()
    expect(toEvaluateRequest(form({ method: 'list', path: 'users' }), 'demo', BUCKET)).toEqual({
      request: { method: 'list', bucket: BUCKET, path: 'users/' },
    })
    expect(toEvaluateRequest(form({ method: 'get', path: '' }), 'demo', BUCKET)).toEqual({
      error: expect.stringMatching(/Name the file/),
    })
  })

  it('asks anonymously with no header, and as a user with a token of their uid, email and claims', () => {
    const anonymous = toEvaluateRequest(form({ path: 'a.png' }), 'demo', BUCKET)
    expect(anonymous).toEqual({ request: { method: 'get', bucket: BUCKET, path: 'a.png' } })
    const built = toEvaluateRequest(
      form({
        path: 'a.png',
        bucket: 'demo-media',
        who: {
          kind: 'as',
          viewAs: {
            kind: 'user',
            uid: 'u_ada',
            email: 'ada@example.test',
            claims: { admin: true },
            tenant: 'team-a',
          },
        },
      }),
      'demo',
      BUCKET,
    )
    if ('error' in built) throw new Error(built.error)
    expect(built.request.bucket).toBe('demo-media')
    const claims = claimsOf(built.request.authorization)
    expect(claims).toMatchObject({
      user_id: 'u_ada',
      email: 'ada@example.test',
      email_verified: true,
      admin: true,
      firebase: { sign_in_provider: 'password', tenant: 'team-a' },
    })
  })

  it('refuses to evaluate as Admin, which skips the rules', () => {
    expect(
      toEvaluateRequest(
        form({ path: 'a.png', who: { kind: 'as', viewAs: { kind: 'owner' } } }),
        'demo',
        BUCKET,
      ),
    ).toEqual({ error: expect.stringMatching(/Admin skips the rules/) })
  })

  it('proposes an upload: its size, its type (none when empty) and its custom metadata', () => {
    const built = toEvaluateRequest(
      form({
        method: 'create',
        path: 'users/u1/big.mov',
        size: '7',
        unit: 'MB',
        contentType: 'video/quicktime',
        metadata: [row('ownerUid', 'u1'), { ...row('off', 'x'), enabled: false }],
      }),
      'demo',
      BUCKET,
    )
    expect(built).toEqual({
      request: {
        method: 'create',
        bucket: BUCKET,
        path: 'users/u1/big.mov',
        proposed: {
          size: 7_340_032,
          contentType: 'video/quicktime',
          customMetadata: { ownerUid: 'u1' },
        },
      },
    })
    const untyped = toEvaluateRequest(
      form({ method: 'create', path: 'a', contentType: '' }),
      'demo',
      BUCKET,
    )
    expect(untyped).toMatchObject({ request: { proposed: { contentType: null } } })
    expect(
      toEvaluateRequest(form({ method: 'create', path: 'a', size: 'big' }), 'demo', BUCKET),
    ).toEqual({
      error: expect.stringMatching(/size/),
    })
  })

  it('changes metadata on update: an empty value removes a key, an empty type keeps the type', () => {
    expect(metadataOf([row('a', 'x'), row('b', '')], 'update')).toEqual({ a: 'x', b: null })
    expect(metadataOf([row('b', '')], 'create')).toEqual({ b: '' })
    const built = toEvaluateRequest(
      form({ method: 'update', path: 'a.png', contentType: '', metadata: [row('b', '')] }),
      'demo',
      BUCKET,
    )
    expect(built).toEqual({
      request: {
        method: 'update',
        bucket: BUCKET,
        path: 'a.png',
        proposed: { customMetadata: { b: null } },
      },
    })
  })

  it('takes the file as missing on request, and a time as RFC 3339', () => {
    const built = toEvaluateRequest(
      form({ path: 'a.png', existing: 'missing', time: '2026-10-12T09:30:00' }),
      'demo',
      BUCKET,
    )
    if ('error' in built) throw new Error(built.error)
    expect(built.request.resource).toBeNull()
    expect(built.request.time).toBe(new Date('2026-10-12T09:30:00').toISOString())
    expect(toEvaluateRequest(form({ path: 'a.png', time: 'soon' }), 'demo', BUCKET)).toEqual({
      error: 'The time is not a date and time.',
    })
  })
})

describe('a recorded request, tried again', () => {
  const recorded: StorageEvaluateRequest = {
    method: 'create',
    bucket: BUCKET,
    path: 'users/u1/big.mov',
    auth: { uid: 'u1', token: { email: 'ada@example.test' } },
    proposed: {
      size: 7_340_032,
      contentType: 'video/quicktime',
      customMetadata: { ownerUid: 'u1' },
    },
    requestResource: { ...OBJECT, name: 'users/u1/big.mov', size: 7_340_032 },
    resource: null,
    time: '2026-10-12T09:00:00Z',
  }

  it('fills the form as it was, and replays it exactly while nothing changes', () => {
    const replay = formFromRequest(recorded, 's7')
    expect(replay).toMatchObject({
      method: 'create',
      path: 'users/u1/big.mov',
      size: '7',
      unit: 'MB',
      contentType: 'video/quicktime',
      who: { kind: 'recorded', auth: { uid: 'u1' } },
      existing: 'missing',
    })
    expect(replay.metadata.map((item) => [item.key, item.value])).toEqual([['ownerUid', 'u1']])
    expect(describeForm(replay, BUCKET)).toBe(
      'create users/u1/big.mov as ada@example.test · 7.00 MB video/quicktime',
    )
    const built = toEvaluateRequest(replay, 'demo', BUCKET)
    if ('error' in built) throw new Error(built.error)
    expect(built.request).toMatchObject({
      auth: recorded.auth,
      resource: null,
      requestResource: recorded.requestResource,
      time: recorded.time,
    })
  })

  it('drops what no longer describes it: the proposed file on an edit, everything on a new path', () => {
    const replay = formFromRequest(recorded, 's7')
    const resized = patchForm(replay, { size: '1' })
    expect(resized.replay?.requestResource).toBeUndefined()
    expect(resized.replay?.resource).toBeNull()
    const elsewhere = patchForm(replay, { path: 'users/u1/other.mov' })
    expect(elsewhere.replay).toBeUndefined()
    const present = patchForm(replay, { existing: 'store' })
    expect(present.replay?.resource).toBeUndefined()
  })

  it('reads the bucket now for a request that recorded no file or time', () => {
    // An upload the Files page judged before sending it: the identity's
    // token and the proposed file, nothing recorded.
    const authorization = `Bearer ${token({ sub: 'u1', user_id: 'u1', email: 'ada@example.test' })}`
    const judged = formFromRequest({
      method: 'create',
      bucket: BUCKET,
      path: 'users/u1/secret.txt',
      authorization,
      proposed: { size: 210, contentType: 'text/plain' },
    })
    expect(judged.replay).toBeUndefined()
    expect(judged.existing).toBe('store')
    expect(judged.who).toEqual({ kind: 'recorded', auth: null, authorization })
    expect(describeForm(judged, BUCKET)).toBe(
      'create users/u1/secret.txt as ada@example.test · 210 B text/plain',
    )
    const built = toEvaluateRequest(judged, 'demo', BUCKET)
    if ('error' in built) throw new Error(built.error)
    expect(built.request.authorization).toBe(authorization)
    expect(built.request.resource).toBeUndefined()
    // A refusal the engine did not record a decision for still replays its file.
    expect(formFromRequest({ ...recorded }, null).replay).toEqual({
      resource: null,
      requestResource: recorded.requestResource,
      time: recorded.time,
    })
  })

  it('names who a token is from: its email, else its uid', () => {
    expect(tokenWho(`Bearer ${token({ sub: 'u1', email: 'ada@example.test' })}`)).toBe(
      'ada@example.test',
    )
    expect(tokenWho(`Firebase ${token({ sub: 'u1', user_id: 'u1' })}`)).toBe('u1')
    expect(tokenWho(`Bearer ${token({ sub: 'u_é' })}`)).toBe('u_é')
    expect(tokenWho('Bearer owner')).toBeUndefined()
    expect(tokenWho('Bearer a.not-json.')).toBeUndefined()
    expect(tokenWho('Basic dXNlcjpwYXNz')).toBeUndefined()
  })

  it('takes a decision the engine no longer keeps from what the feed recorded', () => {
    const decision: StorageDecision = {
      id: 's3',
      at: '2026-10-12T09:00:00Z',
      bucket: BUCKET,
      method: 'create',
      path: 'users/u1/big.mov',
      outcome: 'deny',
      error: null,
      uid: 'u1',
      tenant: null,
      provider: 'password',
      anonymous: false,
      allows: [],
      rulesHash: 'h',
      noRuleset: false,
      size: 7_340_032,
      contentType: 'video/quicktime',
      viaConsole: false,
    }
    const filled = formFromDecision(decision)
    expect(filled).toMatchObject({
      method: 'create',
      path: 'users/u1/big.mov',
      size: '7',
      unit: 'MB',
      contentType: 'video/quicktime',
      who: {
        kind: 'recorded',
        auth: { uid: 'u1', token: { firebase: { sign_in_provider: 'password' } } },
      },
    })
    expect(filled.replay).toBeUndefined()
    expect(formFromDecision({ ...decision, uid: null, anonymous: true }).who).toEqual({
      kind: 'recorded',
      auth: null,
    })
  })
})
