import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import { playgroundSearch, useTryInPlayground } from './rules-link'
import { usePlayground } from './rules-page/playground-store'
import { EMPTY_FORM } from './rules-page/requests'

const DEFAULT = 'demo.appspot.com'

/** A refused upload as the engine carries it beside a 403: the identity's token, the file then. */
const refused: StorageEvaluateRequest = {
  method: 'create',
  bucket: 'demo-media',
  path: 'users/u1/big.mov',
  auth: { uid: 'u1', token: { email: 'ada@example.test' } },
  proposed: { size: 7_340_032, contentType: 'video/quicktime' },
  resource: null,
  time: '2026-10-12T09:00:00Z',
}

/** The Files page, and the Rules page beside it when `rules`, in a router at `/storage`. */
async function mount(rules: boolean) {
  let tryIt: ReturnType<typeof useTryInPlayground>
  const root = createRootRoute({ component: () => <Outlet /> })
  const files = createRoute({
    getParentRoute: () => root,
    path: '/storage',
    component: function Files() {
      tryIt = useTryInPlayground()
      return null
    },
  })
  const page = createRoute({
    getParentRoute: () => root,
    path: '/storage_/rules',
    component: () => null,
  })
  const router = createRouter({
    routeTree: root.addChildren(rules ? [files, page] : [files]),
    history: createMemoryHistory({ initialEntries: ['/storage'] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, tryIt: () => tryIt }
}

describe('trying a refusal in the playground', () => {
  afterEach(() => usePlayground.setState({ form: EMPTY_FORM, run: undefined, pending: false }))

  it('opens the request’s bucket, the default one unwritten', () => {
    expect(playgroundSearch(refused, DEFAULT)).toEqual({
      bucket: 'demo-media',
      panel: 'playground',
    })
    expect(playgroundSearch({ bucket: DEFAULT }, DEFAULT)).toEqual({ panel: 'playground' })
  })

  it('is not offered while the console has no Rules page', async () => {
    const { tryIt } = await mount(false)
    expect(tryIt()).toBeUndefined()
  })

  it('fills the playground with the request, to run on arrival, and opens it', async () => {
    const { router, tryIt } = await mount(true)
    await act(async () => {
      tryIt()?.(refused, { decision: 's7', defaultBucket: DEFAULT })
      await router.load()
    })
    expect(router.state.location.pathname).toBe('/storage/rules')
    expect(router.state.location.search).toEqual({ bucket: 'demo-media', panel: 'playground' })
    const { form, pending, run } = usePlayground.getState()
    expect(pending).toBe(true)
    expect(run).toBeUndefined()
    expect(form).toMatchObject({
      method: 'create',
      bucket: 'demo-media',
      path: 'users/u1/big.mov',
      size: '7',
      unit: 'MB',
      contentType: 'video/quicktime',
      who: { kind: 'recorded', auth: { uid: 'u1' } },
      existing: 'missing',
      replay: { decisionId: 's7', resource: null, time: refused.time },
    })
  })
})
