import { describe, expect, it } from 'vitest'
import { CONNECT_TABS, connectTab } from '@/lib/connect-tabs'
import { rootSearchSchema } from './search'

describe('every page’s address', () => {
  it('opens any tab of the one list by its connect value, each mapped to the generator’s target', () => {
    for (const tab of CONNECT_TABS)
      expect(rootSearchSchema.parse({ connect: tab.param }).connect).toBe(tab.param)
    expect(connectTab('node').target).toBe('admin-node')
    expect(connectTab(undefined).param).toBe('web')
    expect(connectTab('firebase-json').label).toBe('firebase.json')
  })

  it('drops a platform it does not know rather than failing the page', () => {
    expect(rootSearchSchema.parse({ connect: 'cobol' })).toEqual({ connect: undefined })
    expect(rootSearchSchema.parse({})).toEqual({})
  })
})
