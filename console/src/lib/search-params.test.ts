import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  stripSearchParams,
} from '@tanstack/react-router'
import { act, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { mergeSearch, parseSort, printSort, useRouteSearch, zFlag, zSort } from './search-params'

describe('updating search params', () => {
  it('drops undefined, empty text, false and empty lists', () => {
    expect(
      mergeSearch(
        { db: 'shop', path: 'users', q: 'x', tags: ['a'], open: true },
        { path: undefined, q: '', tags: [], open: false },
      ),
    ).toEqual({ db: 'shop' })
  })

  it('keeps what the patch does not touch and adds what it sets', () => {
    expect(mergeSearch({ db: 'shop' }, { user: 'u_9f3k2', tab: 'claims' })).toEqual({
      db: 'shop',
      user: 'u_9f3k2',
      tab: 'claims',
    })
  })

  it('writes paused=true and removes paused=false, so the flag is only ever the paused state', () => {
    expect(mergeSearch({ q: 'level:error' }, { paused: true })).toEqual({
      q: 'level:error',
      paused: true,
    })
    expect(mergeSearch({ q: 'level:error', paused: true }, { paused: false })).toEqual({
      q: 'level:error',
    })
  })

  it('keeps zero, which is a value', () => {
    expect(mergeSearch({}, { line: 0 })).toEqual({ line: 0 })
  })
})

describe('sort', () => {
  it('reads and prints <column>:<direction>', () => {
    expect(parseSort('createdAt:desc')).toEqual({ column: 'createdAt', direction: 'desc' })
    expect(parseSort('metadata.size:asc')).toEqual({ column: 'metadata.size', direction: 'asc' })
    expect(printSort({ column: 'createdAt', direction: 'desc' })).toBe('createdAt:desc')
    expect(printSort(undefined)).toBeUndefined()
  })

  it('reads nothing from a malformed value', () => {
    expect(parseSort(undefined)).toBeUndefined()
    expect(parseSort('')).toBeUndefined()
    expect(parseSort('createdAt')).toBeUndefined()
    expect(parseSort('createdAt:sideways')).toBeUndefined()
    expect(parseSort(':asc')).toBeUndefined()
  })

  it('validates in the route schema', () => {
    expect(zSort.safeParse('createdAt:asc').success).toBe(true)
    expect(zSort.safeParse(undefined).success).toBe(true)
    expect(zSort.safeParse('createdAt:up').success).toBe(false)
  })
})

describe('flags', () => {
  it('is a boolean or absent', () => {
    expect(zFlag.safeParse(true).success).toBe(true)
    expect(zFlag.safeParse(undefined).success).toBe(true)
    expect(zFlag.safeParse('yes').success).toBe(false)
  })
})

/** A page that reads its search and patches it from two buttons. */
function Things() {
  const { search, update } = useRouteSearch<{ q?: string; paused?: boolean; sort?: string }>(
    '/things' as never,
    '/things',
  )
  return createElement(
    'div',
    null,
    createElement('output', { 'data-testid': 'search' }, JSON.stringify(search)),
    createElement(
      'button',
      { type: 'button', onClick: () => update({ paused: true, sort: 'time:desc' }) },
      'Pause',
    ),
    createElement(
      'button',
      { type: 'button', onClick: () => update({ paused: false, q: '' }, { replace: true }) },
      'Resume',
    ),
  )
}

describe('useRouteSearch', () => {
  it('reads the route search and writes patches into the address', async () => {
    const root = createRootRoute()
    const things = createRoute({
      getParentRoute: () => root,
      path: '/things',
      validateSearch: z.object({ q: z.string().optional(), paused: zFlag, sort: zSort }),
      search: { middlewares: [stripSearchParams({})] },
      component: Things,
    })
    const history = createMemoryHistory({ initialEntries: ['/things?q=%22level%3Aerror%22'] })
    const router = createRouter({ routeTree: root.addChildren([things]), history })
    render(createElement(RouterProvider, { router: router as never }))
    expect(await screen.findByTestId('search')).toHaveTextContent('{"q":"level:error"}')

    await act(async () => screen.getByRole('button', { name: 'Pause' }).click())
    expect(router.state.location.search).toEqual({
      q: 'level:error',
      paused: true,
      sort: 'time:desc',
    })
    const pushed = history.length

    await act(async () => screen.getByRole('button', { name: 'Resume' }).click())
    expect(router.state.location.search).toEqual({ sort: 'time:desc' })
    expect(history.length).toBe(pushed)
    expect(screen.getByTestId('search')).toHaveTextContent('{"sort":"time:desc"}')
  })
})
