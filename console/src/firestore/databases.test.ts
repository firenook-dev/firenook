import { describe, expect, it } from 'vitest'
import { databaseItems } from './databases'

describe('databaseItems', () => {
  it('lists what the engine knows, in its order', () => {
    const items = databaseItems(
      {
        databases: [
          { id: '(default)', declared: true },
          { id: 'analytics', declared: false },
        ],
      },
      '(default)',
      '(default)',
    )
    expect(Object.keys(items)).toEqual(['(default)', 'analytics'])
  })

  it('keeps the database on screen even when it is not listed', () => {
    const items = databaseItems(
      { databases: [{ id: '(default)', declared: false }] },
      'typed',
      '(default)',
    )
    expect(Object.keys(items)).toEqual(['(default)', 'typed'])
  })

  it('offers the default alone before the list arrives', () => {
    expect(Object.keys(databaseItems(undefined, '(default)', '(default)'))).toEqual(['(default)'])
    expect(Object.keys(databaseItems(undefined, 'eu', '(default)'))).toEqual(['(default)', 'eu'])
  })
})
