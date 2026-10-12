import { describe, expect, it } from 'vitest'
import order from './section-order.json'
import { SECTIONS } from './services'

describe('the one section order', () => {
  it('is the sidebar order, which the engine sorts its status by', () => {
    // The engine reads the same file (`crates/console-front/src/section.rs`),
    // so the status, search groups and the navigation cannot drift apart.
    expect(SECTIONS.map((section) => section.to.slice(1))).toEqual(order)
  })
})
