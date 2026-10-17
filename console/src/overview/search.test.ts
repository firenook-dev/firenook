import { describe, expect, it } from 'vitest'
import { overviewSearchSchema } from './search'

describe('the overview’s address', () => {
  it('reads the dialog and its section, and drops what it does not know rather than failing', () => {
    expect(overviewSearchSchema.parse({ dialog: 'save' })).toEqual({ dialog: 'save' })
    expect(overviewSearchSchema.parse({ dialog: 'delete-everything', section: 'db' })).toEqual({
      dialog: undefined,
      section: undefined,
    })
    expect(overviewSearchSchema.parse({ dialog: 'reset', section: 'auth' })).toEqual({
      dialog: 'reset',
      section: 'auth',
    })
    expect(overviewSearchSchema.parse({})).toEqual({})
  })
})
