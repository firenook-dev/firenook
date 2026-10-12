import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createFeedStore } from '@/lib/live/feed-store'
import { useSeededPending } from './seeded-pending'

interface Row {
  id: string
}

const key = (row: Row) => row.id
const rows = (count: number, from = 0): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `r${from + index}` }))

/** Lets the store's once-a-frame notification arrive. */
async function frame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

describe('a list opened paused', () => {
  it('counts only what arrives after its first page, never the page itself', async () => {
    const store = createFeedStore<Row>({ max: 100, key })
    const { result, rerender } = renderHook(
      ({ total }: { total: number | undefined }) => useSeededPending(store, true, key, total),
      { initialProps: { total: undefined as number | undefined } },
    )
    expect(result.current).toBe(0)
    // The first page answers, and the list is seeded from it.
    rerender({ total: 20 })
    act(() => store.push(rows(20)))
    await frame()
    expect(result.current).toBe(0)
    act(() => store.push(rows(3, 20)))
    await frame()
    expect(result.current).toBe(3)
  })

  it('counts from the start when the first page is empty', async () => {
    const store = createFeedStore<Row>({ max: 100, key })
    const { result } = renderHook(() => useSeededPending(store, true, key, 0))
    act(() => store.push(rows(2)))
    await frame()
    expect(result.current).toBe(2)
  })

  it('counts nothing while it follows', async () => {
    const store = createFeedStore<Row>({ max: 100, key })
    const { result } = renderHook(() => useSeededPending(store, false, key, 5))
    act(() => store.push(rows(5)))
    await frame()
    expect(result.current).toBe(0)
  })
})
