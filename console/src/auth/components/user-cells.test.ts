import { describe, expect, it } from 'vitest'
import { USER_COLUMN, statusWords, userColumns } from './user-cells'

const row = {
  disabled: false,
  email: 'ada@example.test',
  emailVerified: true,
  mfa: 0,
  claimKeys: [] as string[],
  customAuth: false,
}

describe('statusWords', () => {
  it('says nothing for a verified account with nothing set', () => {
    expect(statusWords(row)).toEqual([])
  })

  it('puts disabled first, the one coloured chip, then the quiet states in order', () => {
    expect(
      statusWords({
        ...row,
        disabled: true,
        emailVerified: false,
        mfa: 2,
        claimKeys: ['role', 'team'],
        customAuth: true,
      }),
    ).toEqual([
      { key: 'disabled', text: 'disabled', tone: 'danger' },
      { key: 'unverified', text: 'unverified' },
      { key: 'mfa', text: 'MFA 2' },
      { key: 'claims', text: 'claims 2' },
      { key: 'custom', text: 'custom' },
    ])
  })

  it('calls an account unverified only when it has an email', () => {
    expect(statusWords({ ...row, email: null, emailVerified: false })).toEqual([])
  })
})

describe('userColumns', () => {
  it('fits everything up to Status in the 876 px a 1440 px window gives the table', () => {
    const columns = userColumns({ sortable: [], pinned: true })
    expect(columns.map((column) => column.id)).toEqual([
      USER_COLUMN,
      'name',
      'providers',
      'created',
      'signedIn',
      'status',
      'phone',
      'uid',
    ])
    const upToStatus = columns.slice(0, columns.findIndex((column) => column.id === 'status') + 1)
    expect(upToStatus.reduce((sum, column) => sum + column.width, 0)).toBeLessThanOrEqual(876)
  })
})
