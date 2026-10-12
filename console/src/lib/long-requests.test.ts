import { describe, expect, it } from 'vitest'
import { createLongRequestBudget } from './long-requests'

describe("a tab's long requests", () => {
  it('holds at most the limit and hands a freed slot to the first in line', async () => {
    const budget = createLongRequestBudget(2)
    const first = await budget.acquire()
    const second = await budget.acquire()
    expect(budget.inUse()).toBe(2)
    const order: string[] = []
    const third = budget.acquire().then((release) => {
      order.push('third')
      return release
    })
    const fourth = budget.acquire().then((release) => {
      order.push('fourth')
      return release
    })
    expect(budget.waiting()).toBe(2)
    first()
    first() // a second release of the same slot does nothing
    const releaseThird = await third
    expect(order).toEqual(['third'])
    expect(budget.inUse()).toBe(2)
    second()
    const releaseFourth = await fourth
    expect(order).toEqual(['third', 'fourth'])
    releaseThird()
    releaseFourth()
    expect(budget.inUse()).toBe(0)
  })

  it('drops a waiter whose request was aborted', async () => {
    const budget = createLongRequestBudget(1)
    const held = await budget.acquire()
    const controller = new AbortController()
    const waiting = budget.acquire(controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow()
    expect(budget.waiting()).toBe(0)
    held()
    expect(budget.inUse()).toBe(0)
    await expect(budget.acquire(controller.signal)).rejects.toThrow()
  })
})
