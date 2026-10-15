import { describe, expect, it } from 'vitest'
import { CONNECT_TABS, connectTab } from '@/lib/connect-tabs'
import { overviewSearchSchema } from './search'

describe('the overview’s address', () => {
  it('reads the snippet and the dialog, and drops what it does not know rather than failing', () => {
    expect(overviewSearchSchema.parse({ connect: 'env', dialog: 'save' })).toEqual({
      connect: 'env',
      dialog: 'save',
    })
    expect(
      overviewSearchSchema.parse({ connect: 'cobol', dialog: 'delete-everything', section: 'db' }),
    ).toEqual({
      connect: undefined,
      dialog: undefined,
      section: undefined,
    })
    expect(overviewSearchSchema.parse({ dialog: 'reset', section: 'auth' })).toEqual({
      dialog: 'reset',
      section: 'auth',
    })
    expect(overviewSearchSchema.parse({})).toEqual({})
  })

  it('opens any tab of the one list by its connect value, each mapped to the generator’s target', () => {
    for (const tab of CONNECT_TABS)
      expect(overviewSearchSchema.parse({ connect: tab.param }).connect).toBe(tab.param)
    expect(connectTab('node').target).toBe('admin-node')
    expect(connectTab(undefined).param).toBe('web')
    expect(connectTab('firebase-json').label).toBe('firebase.json')
  })
})
