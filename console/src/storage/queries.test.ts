import { afterEach, describe, expect, it, vi } from 'vitest'
import { OWNER_AUTHORIZATION } from '@/lib/identity'
import { STORAGE_API } from './api'
import {
  ALL_BUCKETS,
  entryKey,
  objectsList,
  readFreshNext,
  rulesScope,
  scopeBucket,
  storageKeys,
  storageRulesBackend,
} from './queries'

afterEach(() => vi.unstubAllGlobals())

function answering(body: unknown) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    return new Response(JSON.stringify(body), { status: 200 })
  })
  return requests
}

describe('Storage’s query keys', () => {
  it('lead with the section and the project, then the bucket, so a bucket resets by prefix', () => {
    const bucket = storageKeys.bucket('demo', 'b')
    for (const key of [
      storageKeys.objects('demo', 'b', 'users/', {
        flat: false,
        kind: 'all',
        sort: undefined,
        q: undefined,
        as: 'owner',
      }),
      storageKeys.folder('demo', 'b', 'users/'),
      storageKeys.object('demo', 'b', 'users/a.png', 'owner'),
      storageKeys.activity('demo', 'b', 'users/a.png'),
      storageKeys.events('demo', 'b', 'users/a.png', '3'),
      storageKeys.sessions('demo', 'b'),
      storageKeys.access('demo', 'b', 'owner', ['a.png']),
    ])
      expect(key.slice(0, bucket.length)).toEqual([...bucket])
    expect(storageKeys.buckets('demo')).toEqual(['storage', 'demo', 'buckets'])
    expect(storageKeys.object('demo', 'b', 'a', 'owner').slice(0, 5)).toEqual([
      ...storageKeys.objectAnyone('demo', 'b', 'a'),
    ])
  })

  it('keep the rules under their scope: the bucket in per-bucket mode, * otherwise', () => {
    expect(rulesScope({ rulesMode: 'perBucket' }, 'media')).toBe('media')
    expect(rulesScope({ rulesMode: 'single' }, 'media')).toBe(ALL_BUCKETS)
    expect(rulesScope({ rulesMode: 'openDefault' }, 'media')).toBe(ALL_BUCKETS)
    expect(rulesScope(undefined, 'media')).toBe(ALL_BUCKETS)
    expect(scopeBucket(ALL_BUCKETS)).toBeUndefined()
    expect(storageKeys.rules('demo', 'media')).toEqual(['storage', 'demo', 'media', 'rules'])
  })
})

describe('a listing as the rows hook takes it', () => {
  it('keys a row by its folder prefix or its name', () => {
    expect(
      entryKey({
        type: 'folder',
        prefix: 'users/',
        objects: 1,
        bytes: 2,
        folders: 0,
        changedAt: null,
        empty: false,
      }),
    ).toBe('users/')
    expect(
      entryKey({
        type: 'file',
        name: 'users/a.png',
        size: 1,
        contentType: null,
        contentEncoding: null,
        updated: '',
        timeCreated: '',
        generation: '1',
        tokens: 0,
        metadataKeys: [],
        metadataCount: 0,
      }),
    ).toBe('users/a.png')
  })

  it('reads pages and batch reads as the identity, with the listing’s scope', async () => {
    const requests = answering({ items: [] })
    const list = objectsList(
      'demo',
      { bucket: 'b', prefix: 'users/', sort: 'size:desc' },
      { kind: 'owner' },
    )
    expect(list.queryKey).toEqual([
      'storage',
      'demo',
      'b',
      'objects',
      'users/',
      { flat: false, kind: 'all', sort: 'size:desc', q: undefined, as: 'owner' },
    ])
    expect(list.options.maxPages).toBe(20)
    await list.fetchPage({ before: 'v1.x' }, new AbortController().signal)
    await list.batchGet({ keys: ['users/a.png'], pageStarts: [null] }, new AbortController().signal)
    expect(requests[0]?.url).toBe(
      `${STORAGE_API}/objects?bucket=b&prefix=users%2F&sort=size%3Adesc&before=v1.x`,
    )
    expect(new Headers(requests[0]?.init.headers).get('authorization')).toBe(OWNER_AUTHORIZATION)
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      keys: ['users/a.png'],
      pageStarts: [null],
      bucket: 'b',
      prefix: 'users/',
      flat: false,
      kind: 'all',
    })
  })
})

describe('Refresh', () => {
  it('reads the next first page fresh, once, and never a later page', async () => {
    const requests = answering({ items: [] })
    const list = objectsList(
      'demo',
      { bucket: 'b', prefix: 'v/', sort: 'size:desc' },
      {
        kind: 'owner',
      },
    )
    const signal = new AbortController().signal
    readFreshNext(list.queryKey)
    await list.fetchPage({ cursor: 'v1.next' }, signal)
    await list.fetchPage({}, signal)
    await list.fetchPage({}, signal)
    const fresh = requests.map((request) =>
      new URL(request.url, 'http://x').searchParams.get('fresh'),
    )
    expect(fresh).toEqual([null, 'true', null])
    // Another listing's Refresh is its own.
    readFreshNext(['storage', 'demo', 'b', 'objects', 'other/'])
    await list.fetchPage({}, signal)
    expect(new URL(requests.at(-1)?.url ?? '', 'http://x').searchParams.get('fresh')).toBeNull()
  })
})

describe('the rules backend the kit’s draft runs on', () => {
  it('keeps the draft per project and scope, and installs into the scope', async () => {
    const requests = answering({ bucket: null, saved: true, path: '/project/storage.rules' })
    const all = storageRulesBackend('demo', ALL_BUCKETS)
    expect(all.draftKey).toBe('firenook.console.storage-rules-draft.demo.*')
    await expect(all.put('rules_version = "2";', true)).resolves.toEqual({
      saved: true,
      path: '/project/storage.rules',
    })
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      source: 'rules_version = "2";',
      save: true,
    })
    await storageRulesBackend('demo', 'media').put('x', false)
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      bucket: 'media',
      source: 'x',
      save: false,
    })
    expect(requests[1]?.init.method).toBe('PUT')
  })
})
