import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentExample, isDocumentPath, resolveDocument } from './document-path'
import { firestoreScope, getDocument } from './rest'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('what doc= names', () => {
  it('a document is an even number of non-empty segments', () => {
    for (const path of ['orders/x', 'users/u1/orders/o1', 'a/b'])
      expect(isDocumentPath(path)).toBe(true)
    for (const path of ['', 'x', 'orders', 'users/u1/orders', 'a//b', '/a', 'a/'])
      expect(isDocumentPath(path)).toBe(false)
  })

  it('reads a bare id against the open collection, and a whole path as it is', () => {
    const view = { collectionPath: 'orders', group: false }
    expect(resolveDocument('x', view)).toBe('orders/x')
    expect(resolveDocument('orders/x', view)).toBe('orders/x')
    expect(resolveDocument('/users/u1/', view)).toBe('users/u1')
    expect(resolveDocument('users//u1', view)).toBe('users/u1')
    expect(resolveDocument('x', { collectionPath: 'users/u1/orders', group: false })).toBe(
      'users/u1/orders/x',
    )
    expect(resolveDocument(undefined, view)).toBeUndefined()
    expect(resolveDocument('', view)).toBeUndefined()
    expect(resolveDocument('/', view)).toBeUndefined()
  })

  it('keeps what names no document as written, for the panel to say so', () => {
    // At the root there is no collection to read an id in.
    expect(resolveDocument('x', { collectionPath: '', group: false })).toBe('x')
    // A collection group's rows live in many collections.
    expect(resolveDocument('x', { collectionPath: 'orders', group: true })).toBe('x')
    // A collection, or a path one segment short of a document.
    expect(resolveDocument('users/u1/orders', { collectionPath: 'orders', group: false })).toBe(
      'users/u1/orders',
    )
    for (const path of ['x', 'users/u1/orders']) expect(isDocumentPath(path)).toBe(false)
  })

  it('suggests a document path from the collection on screen', () => {
    expect(documentExample('x', 'orders')).toBe('orders/x')
    expect(documentExample('users/u1/orders', '')).toBe('orders/orders')
    expect(documentExample('x', 'users/*/orders')).toBe('orders/x')
  })
})

describe('reading a document', () => {
  const scope = firestoreScope({
    project: 'demo-test',
    database: '(default)',
    identity: { kind: 'owner' },
  })

  it('asks nothing for a path that names no document', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(getDocument(scope, 'x')).resolves.toBeNull()
    await expect(getDocument(scope, 'users/u1/orders')).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads an answer that is no document (a listing) as not found, not a crash', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    )
    await expect(getDocument(scope, 'orders/x')).resolves.toBeNull()
  })

  it('decodes a document the engine answers', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            name: 'projects/demo-test/databases/(default)/documents/orders/x',
            fields: { total: { integerValue: '3' } },
            updateTime: '2026-10-20T09:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const document = await getDocument(scope, 'orders/x')
    expect(document?.path).toBe('orders/x')
    expect(document?.fields.total).toEqual({ type: 'number', value: 3, integer: true })
  })
})
