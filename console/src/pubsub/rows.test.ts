import { describe, expect, it } from 'vitest'
import { compareIds, dedupeRows, idsAbove, renumberPlaces } from './rows'

describe('rows merged from pages (U-11)', () => {
  it('keep each id once, the first copy, and the same array when nothing repeats', () => {
    const rows = [
      { id: '9', copy: 'head' },
      { id: '8', copy: 'head' },
      { id: '8', copy: 'old page' },
      { id: '7', copy: 'old page' },
    ]
    expect(dedupeRows(rows, (row) => row.id)).toEqual([
      { id: '9', copy: 'head' },
      { id: '8', copy: 'head' },
      { id: '7', copy: 'old page' },
    ])
    const unique = rows.slice(0, 2)
    expect(dedupeRows(unique, (row) => row.id)).toBe(unique)
  })

  it('backlog positions are keys, so a moved row is one gone key and one new key', () => {
    // The engine's key is `phase.order.id`: a nack moves a message to a new order.
    const before = ['1.1.1', '1.2.2', '1.3.3']
    const after = ['1.2.2', '1.3.3', '1.4.1']
    expect(before.filter((key) => !after.includes(key))).toEqual(['1.1.1'])
    expect(after.filter((key) => !before.includes(key))).toEqual(['1.4.1'])
  })
})

const row = (state: string, place: number | null) => ({ state, place })

describe('backlog places (U-11)', () => {
  it('number the available rows from 1 at the head, consecutively', () => {
    const rows = [
      row('outstanding', null),
      row('available', 2),
      row('available', 3),
      row('available', 5),
    ]
    expect(renumberPlaces(rows, true).map((entry) => entry.place)).toEqual([null, 1, 2, 3])
  })

  it('number on from the engine’s place when the window starts further down', () => {
    const rows = [row('available', 101), row('available', 103)]
    expect(renumberPlaces(rows, false).map((entry) => entry.place)).toEqual([101, 102])
  })

  it('answer the same array when every place is right', () => {
    const rows = [row('available', 1), row('available', 2)]
    expect(renumberPlaces(rows, true)).toBe(rows)
    const none = [row('outstanding', null)]
    expect(renumberPlaces(none, true)).toBe(none)
  })
})

describe('ids, which may pass 2^53 (U-11)', () => {
  it('compare by length, then digits', () => {
    expect(compareIds('10', '9')).toBeGreaterThan(0)
    expect(compareIds('9007199254740993', '9007199254740992')).toBeGreaterThan(0)
    expect(compareIds('42', '42')).toBe(0)
    expect(compareIds('100', '99')).toBeGreaterThan(0)
  })

  it('flash only what is above the head last drawn, whatever other topics took meanwhile', () => {
    // Ids are one counter for every topic: 1185 went to another topic.
    const rows = [{ id: '1188' }, { id: '1186' }, { id: '1184' }, { id: '1183' }]
    expect(idsAbove(rows, (entry) => entry.id, '1184')).toEqual(['1188', '1186'])
    expect(idsAbove(rows, (entry) => entry.id, '1188')).toEqual([])
    expect(idsAbove(rows, (entry) => entry.id, undefined)).toEqual([])
  })
})
