import { describe, expect, it } from 'vitest'
import {
  bulkTarget,
  deleteRefusal,
  jobVerb,
  needsDryRun,
  previewSentence,
  withoutTriggersOffer,
} from './bulk'
import { exportFilename, exportHref } from './export'

describe('bulk changes', () => {
  it('target the ticked users by key, or every match by the filter', () => {
    const scope = { kind: 'tenant', tenant: 'acme' } as const
    expect(
      bulkTarget(scope, { checked: new Set(['a', 'b|c']), everything: false }, 'is:disabled'),
    ).toEqual({
      by: 'keys',
      keys: ['acme|a', 'acme|b|c'],
    })
    expect(bulkTarget(scope, { checked: new Set(['a']), everything: true }, 'is:disabled')).toEqual(
      {
        by: 'query',
        q: 'is:disabled',
        scope: { tenant: 'acme' },
      },
    )
    expect(bulkTarget({ kind: 'project' }, { checked: new Set(), everything: true }, '')).toEqual({
      by: 'query',
      q: '',
      scope: {},
    })
  })

  it('ask the engine first for a query or more than 50 users', () => {
    expect(needsDryRun({ by: 'keys', keys: Array.from({ length: 50 }, (_, n) => `|u${n}`) })).toBe(
      false,
    )
    expect(needsDryRun({ by: 'keys', keys: Array.from({ length: 51 }, (_, n) => `|u${n}`) })).toBe(
      true,
    )
    expect(needsDryRun({ by: 'query', q: '', scope: {} })).toBe(true)
  })

  it('say the real numbers', () => {
    expect(
      previewSentence('disable', {
        matched: 1_204,
        changed: 1_201,
        unchanged: 3,
        triggers: 0,
        tookMicros: 1,
      }),
    ).toBe('Disable 1,204 users? 3 are already disabled.')
    expect(
      previewSentence('enable', {
        matched: 1,
        changed: 1,
        unchanged: 0,
        triggers: 0,
        tookMicros: 1,
      }),
    ).toBe('Enable 1 user?')
  })

  it('offer a delete without triggers only for everyone or the sample users', () => {
    expect(withoutTriggersOffer({ by: 'query', q: '', scope: {} })).toBe('offered')
    expect(withoutTriggersOffer({ by: 'query', q: ' is:sample ', scope: {} })).toBe('default')
    expect(withoutTriggersOffer({ by: 'query', q: 'is:disabled', scope: {} })).toBe('off')
    expect(withoutTriggersOffer({ by: 'keys', keys: ['|a'] })).toBe('off')
    expect(deleteRefusal(10_000, true)).toBeUndefined()
    expect(deleteRefusal(10_001, true)).toMatch(/limited to 10,000/)
    expect(deleteRefusal(50_000, false)).toBeUndefined()
  })

  it('count a job’s items in the words of the engine’s kinds', () => {
    expect(jobVerb('auth.disable')).toBe('disabled')
    expect(jobVerb('auth.revoke')).toBe('revoked')
    expect(jobVerb('auth.import')).toBe('imported')
    expect(jobVerb('auth.delete')).toBe('deleted')
    expect(jobVerb('auth.set-claims')).toBe('changed')
    expect(jobVerb('auth.remove-claims')).toBe('changed')
  })
})

describe('exports', () => {
  it('name the file as the engine does and address what is chosen', () => {
    expect(exportFilename('demo-x', 'acme', 'json', new Date(Date.UTC(2026, 9, 2, 3, 4)))).toBe(
      'auth-users-demo-x-acme-20261002-0304.json',
    )
    const base = {
      project: 'demo-x',
      tenant: undefined,
      format: 'csv' as const,
      q: 'is:disabled',
      selected: ['a', 'b'],
    }
    expect(exportHref({ ...base, scope: 'filter' })).toBe(
      '/console/api/v1/auth/users:export?project=demo-x&format=csv&q=is%3Adisabled',
    )
    expect(exportHref({ ...base, scope: 'selected' })).toBe(
      '/console/api/v1/auth/users:export?project=demo-x&format=csv&uid=a&uid=b',
    )
    expect(exportHref({ ...base, scope: 'all' })).toBe(
      '/console/api/v1/auth/users:export?project=demo-x&format=csv',
    )
  })
})
