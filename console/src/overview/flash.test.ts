import { describe, expect, it } from 'vitest'
import { FLASH_GAP_MS, createFlashGate } from './flash'

describe('a card figure’s flash', () => {
  it('never flashes for the value the page opened on', () => {
    const gate = createFlashGate()
    expect(gate.observe(10, 0)).toBe(false)
    expect(gate.observe(10, 500)).toBe(false)
  })

  it('flashes when the figure changes, at most once every 5 s', () => {
    const gate = createFlashGate()
    gate.observe(10, 0)
    expect(gate.observe(11, 1000)).toBe(true)
    expect(gate.observe(11, 1500)).toBe(false)
    expect(gate.observe(12, 3000)).toBe(false)
    expect(gate.observe(12, 3500)).toBe(false)
    expect(gate.observe(13, 1000 + FLASH_GAP_MS)).toBe(true)
  })

  it('stops while the figure changes in each of the last three statuses, until it rests for 5 s', () => {
    const gate = createFlashGate()
    gate.observe(0, 0)
    // A write loop: a new value in every status, twice a second.
    expect(gate.observe(1, 500)).toBe(true)
    const flashes = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].filter(
      (value, index) => gate.observe(value, 1000 + index * 500),
    )
    // Eight seconds of changes and no second flash, though 5 s passed.
    expect(flashes).toEqual([])
    // A status with the same value, then a change within 5 s of the last one: still resting.
    expect(gate.observe(17, 9000)).toBe(false)
    expect(gate.observe(18, 10_000)).toBe(false)
    // Rested for 5 s, the next change flashes again.
    expect(gate.observe(18, 12_000)).toBe(false)
    expect(gate.observe(19, 16_000)).toBe(true)
  })

  it('treats a figure that starts or stops being counted as a change', () => {
    const gate = createFlashGate()
    gate.observe(null, 0)
    expect(gate.observe(3, 6000)).toBe(true)
  })
})
