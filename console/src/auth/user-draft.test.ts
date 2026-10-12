import { describe, expect, it } from 'vitest'
import {
  type UserValues,
  changedFields,
  draftBase,
  draftConflicts,
  draftProblems,
  editDraft,
  keepMine,
  shownValue,
  updateBody,
  takeTheirs,
} from './user-draft'

const server: UserValues = {
  displayName: 'Ada Lovelace',
  photoUrl: '',
  email: 'ada@example.test',
  emailVerified: true,
  phoneNumber: '',
  disabled: false,
  createdAt: '2026-10-10T09:14:02.112Z',
  lastLoginAt: '2026-10-12T10:00:00.000Z',
  claims: '',
}

describe('the inspector draft', () => {
  it('never conflicts a sign-in with a display-name edit', () => {
    const draft = editDraft({}, server, 'displayName', 'Ada L.')
    const signedIn = { ...server, lastLoginAt: '2026-10-12T11:00:00.000Z' }
    expect(draftConflicts(draftBase(draft), signedIn, draft)).toEqual([])
    expect(shownValue(draft, signedIn, 'lastLoginAt')).toBe(signedIn.lastLoginAt)
  })

  it('conflicts when someone else changes the field being edited', () => {
    const draft = editDraft({}, server, 'displayName', 'Ada L.')
    const renamed = { ...server, displayName: 'Countess' }
    expect(draftConflicts(draftBase(draft), renamed, draft)).toEqual([
      { field: 'displayName', mine: 'Ada L.', theirs: 'Countess' },
    ])
    // Use theirs drops the field; keep mine answers the conflict.
    expect(takeTheirs(draft, 'displayName')).toEqual({})
    const kept = keepMine(draft, renamed, 'displayName')
    expect(draftConflicts(draftBase(kept), renamed, kept)).toEqual([])
    expect(changedFields(kept, renamed)).toEqual(['displayName'])
  })

  it('is no conflict when the other change says what was typed', () => {
    const draft = editDraft({}, server, 'displayName', 'Ada L.')
    expect(draftConflicts(draftBase(draft), { ...server, displayName: 'Ada L.' }, draft)).toEqual(
      [],
    )
  })

  it('counts a change only while it differs from the server, by value', () => {
    let draft = editDraft({}, server, 'createdAt', '2026-10-10T09:14:02.112Z')
    draft = editDraft(draft, server, 'claims', '{\n  }')
    expect(changedFields(draft, server)).toEqual([])
    draft = editDraft(draft, server, 'claims', '{"role": "admin"}')
    expect(changedFields(draft, server)).toEqual(['claims'])
  })

  it('says what is wrong before Save', () => {
    let draft = editDraft({}, server, 'email', 'not-an-email')
    draft = editDraft(draft, server, 'phoneNumber', '5550100')
    draft = editDraft(draft, server, 'createdAt', 'yesterday')
    draft = editDraft(draft, server, 'claims', '{"iss": 1}')
    expect(Object.keys(draftProblems(draft)).toSorted()).toEqual([
      'claims',
      'createdAt',
      'email',
      'phoneNumber',
    ])
    expect(draftProblems(editDraft({}, server, 'phoneNumber', '+1 (555) 0100'))).toEqual({})
  })

  it('writes one accounts:update the way the Admin SDK does', () => {
    let draft = editDraft({}, server, 'displayName', '')
    draft = editDraft(draft, server, 'phoneNumber', '+1 555 0100')
    draft = editDraft(draft, server, 'disabled', true)
    draft = editDraft(draft, server, 'createdAt', '2026-01-01T00:00:00Z')
    draft = editDraft(draft, server, 'claims', '{ "role": "admin" }')
    expect(updateBody('u_ada', draft, server)).toEqual({
      localId: 'u_ada',
      phoneNumber: '+15550100',
      disableUser: true,
      createdAt: String(Date.parse('2026-01-01T00:00:00Z')),
      customAttributes: '{"role":"admin"}',
      deleteAttribute: ['DISPLAY_NAME'],
    })
    expect(
      updateBody('u_ada', editDraft({}, { ...server, claims: '{"a":1}' }, 'claims', ''), {
        ...server,
        claims: '{"a":1}',
      }),
    ).toEqual({
      localId: 'u_ada',
      customAttributes: '{}',
    })
    expect(
      updateBody('u_ada', editDraft({}, { ...server, phoneNumber: '+1' }, 'phoneNumber', ''), {
        ...server,
        phoneNumber: '+1',
      }),
    ).toEqual({
      localId: 'u_ada',
      deleteProvider: ['phone'],
    })
  })
})
