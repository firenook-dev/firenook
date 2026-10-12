import { describe, expect, it } from 'vitest'
import { createLongRequestBudget } from '@/lib/long-requests'
import { type Release, createStoragePool } from './net'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Long enough for every queued grant and release to have run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('one pool of long requests per tab', () => {
  it('lets uploads take all three slots while no picture is around', async () => {
    const pool = createStoragePool(createLongRequestBudget(3), 3)
    const granted: Release[] = []
    for (let index = 0; index < 4; index += 1)
      void pool.acquire('upload').then((release) => granted.push(release))
    await flush()
    expect(granted).toHaveLength(3)
    expect(pool.snapshot()).toEqual({ uploads: 3, pictures: 0, waiting: 1 })
    granted[0]?.()
    await flush()
    expect(granted).toHaveLength(4)
  })

  it('keeps uploads to two while pictures are on screen', async () => {
    const pool = createStoragePool(createLongRequestBudget(3), 3)
    const stop = pool.demandPictures()
    const granted: Release[] = []
    for (let index = 0; index < 3; index += 1)
      void pool.acquire('upload').then((release) => granted.push(release))
    await flush()
    expect(granted).toHaveLength(2)
    stop()
    await flush()
    expect(granted).toHaveLength(3)
  })

  it('gives the next slot to the preview, then tiles in view order, then uploads', async () => {
    const pool = createStoragePool(createLongRequestBudget(1), 1)
    const order: string[] = []
    const first = await pool.acquire('upload')
    void pool.acquire('upload').then((release) => {
      order.push('upload')
      release()
    })
    void pool.acquire('tile', { order: 9 }).then((release) => {
      order.push('tile 9')
      release()
    })
    void pool.acquire('tile', { order: 2 }).then((release) => {
      order.push('tile 2')
      release()
    })
    void pool.acquire('preview').then((release) => {
      order.push('preview')
      release()
    })
    first()
    await settle()
    expect(order).toEqual(['preview', 'tile 2', 'tile 9', 'upload'])
  })

  it('drops a tile that left the view before its turn', async () => {
    const pool = createStoragePool(createLongRequestBudget(1), 1)
    const held = await pool.acquire('preview')
    const controller = new AbortController()
    const left = pool.acquire('tile', { order: 1, signal: controller.signal })
    controller.abort()
    await expect(left).rejects.toThrow(/cancelled/)
    expect(pool.snapshot().waiting).toBe(0)
    held()
  })

  it('shares the tab’s budget with the rest of the console', async () => {
    const budget = createLongRequestBudget(3)
    const other = await budget.acquire()
    const pool = createStoragePool(budget, 3)
    const granted: Release[] = []
    for (let index = 0; index < 3; index += 1)
      void pool.acquire('upload').then((release) => granted.push(release))
    await flush()
    expect(granted).toHaveLength(2)
    other()
    await flush()
    expect(granted).toHaveLength(3)
  })
})
