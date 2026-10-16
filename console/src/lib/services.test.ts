import { describe, expect, it } from 'vitest'
import order from './section-order.json'
import { SECTIONS, itemBadges, sectionById } from './services'

describe('the one section order', () => {
  it('is the sidebar order, which the engine sorts its status by', () => {
    // The engine reads the same file (`crates/console-front/src/section.rs`),
    // so the status, search groups and the navigation cannot drift apart.
    expect(SECTIONS.map((section) => section.id)).toEqual(order)
  })

  it('routes each section at its id', () => {
    for (const section of SECTIONS) expect(section.to).toBe(`/${section.id}`)
  })
})

describe('finding a section', () => {
  it('by id, and nothing for a string that names none', () => {
    expect(sectionById('firestore')?.label).toBe('Firestore')
    expect(sectionById('toString')).toBeUndefined()
    expect(sectionById('overview')).toBeUndefined()
  })
})

describe('a section item’s badges', () => {
  it('are its registry’s and its running jobs’ gauge', () => {
    const firestore = sectionById('firestore')
    if (!firestore) throw new Error('no Firestore section')
    expect(itemBadges(firestore)).toEqual(['firestore.jobs'])
    expect(itemBadges({ ...firestore, badges: ['firestore.x'] })).toEqual([
      'firestore.x',
      'firestore.jobs',
    ])
  })
})
