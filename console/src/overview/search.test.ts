import { describe, expect, it } from 'vitest'
import { CONNECT_TABS, connectTab } from './connect-tabs'
import { CONNECT_PARAMS, overviewSearchSchema } from './search'

describe('the overview’s address', () => {
  it('reads the snippet and the dialog, and drops what it does not know rather than failing', () => {
    expect(overviewSearchSchema.parse({ connect: 'env', dialog: 'snapshot' })).toEqual({
      connect: 'env',
      dialog: 'snapshot',
    })
    expect(overviewSearchSchema.parse({ connect: 'cobol', dialog: 'delete-everything' })).toEqual({
      connect: undefined,
      dialog: undefined,
    })
    expect(overviewSearchSchema.parse({})).toEqual({})
  })

  it('has one tab per connect value, in order, each mapped to the generator’s target', () => {
    expect(CONNECT_TABS.map((tab) => tab.param)).toEqual([...CONNECT_PARAMS])
    expect(connectTab('node').target).toBe('admin-node')
    expect(connectTab(undefined).param).toBe('web')
    expect(connectTab('firebase-json').label).toBe('firebase.json')
  })
})
