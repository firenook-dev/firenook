import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { type InvokeDraft, draftKey, useRunDraft, useRunDrafts } from './run-drafts'

// The Run tab's drafts: one per project, function and form, kept in this
// tab's sessionStorage, holding who a call is made as and never a token.

const empty = (): InvokeDraft => ({
  kind: 'request',
  method: 'GET',
  path: '/',
  query: [],
  headers: [],
  body: { kind: 'none', text: '' },
  identity: { kind: 'owner' },
  appCheck: { kind: 'none' },
})

const stored = () =>
  JSON.parse(sessionStorage.getItem('firenook.console.run-drafts') ?? '{}') as {
    state?: { drafts?: Record<string, unknown> }
  }

describe('a Run draft', () => {
  beforeEach(() => {
    sessionStorage.clear()
    useRunDrafts.setState({ drafts: {} })
  })

  it('starts from the form until something is typed, then keeps what was typed', () => {
    const { result } = renderHook(() => useRunDraft('demo-x', 'us-central1-api', empty))
    expect(result.current[0]).toEqual(empty())
    act(() => result.current[1]({ ...empty(), path: '/hello' }))
    expect(result.current[0].path).toBe('/hello')
    expect(
      stored().state?.drafts?.[draftKey('demo-x', 'us-central1-api', 'request')],
    ).toMatchObject({ path: '/hello' })
  })

  it('is kept per project and function, so another function starts clean', () => {
    const api = renderHook(() => useRunDraft('demo-x', 'us-central1-api', empty))
    act(() => api.result.current[1]({ ...empty(), path: '/a' }))
    const ping = renderHook(() => useRunDraft('demo-x', 'us-central1-ping', empty))
    const other = renderHook(() => useRunDraft('demo-y', 'us-central1-api', empty))
    expect(ping.result.current[0].path).toBe('/')
    expect(other.result.current[0].path).toBe('/')
    act(() => api.result.current[2]())
    expect(api.result.current[0].path).toBe('/')
  })

  it('keeps who the call is made as, never a token', () => {
    const { result } = renderHook(() => useRunDraft('demo-x', 'us-central1-api', empty))
    act(() =>
      result.current[1]({
        ...empty(),
        identity: { kind: 'user', uid: 'u_k65eq', email: 'ada@example.test' },
        appCheck: { kind: 'app', appId: '1:123:web:abc' },
      }),
    )
    const kept = JSON.stringify(stored())
    expect(kept).toContain('u_k65eq')
    expect(kept).not.toMatch(/Bearer|eyJ/)
  })
})
