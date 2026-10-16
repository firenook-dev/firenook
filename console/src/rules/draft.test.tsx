import { QueryClient, QueryClientProvider, queryOptions } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type RulesBackend, type RulesDocumentLike, useRulesDraft } from './draft'
import { RulesCompileError } from './text'

interface Doc extends RulesDocumentLike {
  hash: string
}

/** One scope's rules, kept here as an engine would keep them. */
function engine(source: string) {
  const state = {
    doc: {
      source,
      enforced: true,
      path: '/p/storage.rules',
      fileSource: source,
      fileProblems: [],
      hash: 'h0',
    } as Doc,
  }
  const put = vi.fn(async (text: string, save: boolean) => {
    if (text.includes('broken'))
      throw new RulesCompileError('The rules do not compile.', [
        {
          severity: 'error',
          message: "expected '{'",
          line: 1,
          column: 9,
          from: 8,
          to: 8,
          code: null,
        },
      ])
    state.doc = {
      ...state.doc,
      source: text,
      hash: `h-${text.length}`,
      ...(save ? { fileSource: text } : {}),
    }
    return { saved: save, path: save ? state.doc.path : null }
  })
  const backend = (scope: string): RulesBackend<Doc, string[]> => ({
    draftKey: `firenook.console.test-rules-draft.${scope}`,
    document: queryOptions({
      queryKey: ['test', scope, 'rules'],
      queryFn: async () => state.doc,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    }),
    put,
  })
  return { state, put, backend }
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

beforeEach(() => sessionStorage.clear())

describe('a rules draft', () => {
  it('is the rules in force until it is edited, and keeps the edit in this tab per scope', async () => {
    const rules = engine('v1')
    const client = new QueryClient()
    const { result, rerender } = renderHook(({ scope }) => useRulesDraft(rules.backend(scope)), {
      wrapper: wrapper(client),
      initialProps: { scope: 'a' },
    })
    await waitFor(() => expect(result.current.rules.isSuccess).toBe(true))
    expect(result.current).toMatchObject({ source: 'v1', inForce: 'v1', edited: false })
    act(() => result.current.setSource('v1 edited'))
    expect(result.current).toMatchObject({ source: 'v1 edited', edited: true, overtaken: false })
    expect(JSON.parse(sessionStorage.getItem('firenook.console.test-rules-draft.a') ?? '')).toEqual(
      {
        base: 'v1',
        text: 'v1 edited',
      },
    )
    // Another scope has no draft; coming back finds it again.
    rerender({ scope: 'b' })
    await waitFor(() => expect(result.current.edited).toBe(false))
    rerender({ scope: 'a' })
    await waitFor(() => expect(result.current.source).toBe('v1 edited'))
  })

  it('says when the rules in force moved under it, and can keep it or let it go', async () => {
    const rules = engine('v1')
    const client = new QueryClient()
    const { result } = renderHook(() => useRulesDraft(rules.backend('a')), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.rules.isSuccess).toBe(true))
    act(() => result.current.setSource('mine'))
    // Saved from somewhere else.
    rules.state.doc = { ...rules.state.doc, source: 'theirs' }
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['test', 'a', 'rules'] })
    })
    await waitFor(() => expect(result.current.overtaken).toBe(true))
    act(() => result.current.rebase())
    expect(result.current).toMatchObject({ overtaken: false, edited: true, source: 'mine' })
    act(() => result.current.revert())
    expect(result.current).toMatchObject({ edited: false, source: 'theirs' })
  })

  it('applies: in force at once, the draft gone; a refused text keeps the draft and says where', async () => {
    const rules = engine('v1')
    const client = new QueryClient()
    const { result } = renderHook(() => useRulesDraft(rules.backend('a')), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.rules.isSuccess).toBe(true))
    act(() => result.current.setSource('broken {'))
    act(() => result.current.apply(false))
    await waitFor(() => expect(result.current.rejected).toHaveLength(1))
    expect(result.current).toMatchObject({ edited: true, source: 'broken {' })
    act(() => result.current.setSource('v2'))
    act(() => result.current.apply(true))
    await waitFor(() => expect(result.current.edited).toBe(false))
    expect(rules.put).toHaveBeenLastCalledWith('v2', true)
    expect(result.current).toMatchObject({ source: 'v2', inForce: 'v2', rejected: [] })
    expect(sessionStorage.getItem('firenook.console.test-rules-draft.a')).toBeNull()
  })
})
