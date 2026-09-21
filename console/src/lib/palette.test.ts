import { describe, expect, it } from 'vitest'
import { type PaletteItem, matchesQuery } from './palette'

const item: PaletteItem = {
  id: 'layout:nav:expanded',
  title: 'Sidebar: expanded',
  breadcrumbs: ['users/*/orders'],
  keywords: 'navigation layout',
  icon: null,
  run: () => {},
}

describe('matchesQuery', () => {
  it('matches every word anywhere in the title, breadcrumbs or keywords', () => {
    expect(matchesQuery(item, '')).toBe(true)
    expect(matchesQuery(item, '   ')).toBe(true)
    expect(matchesQuery(item, 'sidebar expanded')).toBe(true)
    expect(matchesQuery(item, 'EXPANDED nav')).toBe(true)
    expect(matchesQuery(item, 'orders sidebar')).toBe(true)
    expect(matchesQuery(item, 'sidebar collapsed')).toBe(false)
    expect(matchesQuery({ ...item, breadcrumbs: undefined, keywords: undefined }, 'nav')).toBe(
      false,
    )
  })
})
