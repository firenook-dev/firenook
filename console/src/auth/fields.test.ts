import { describe, expect, it } from 'vitest'
import type { AuthActivityFacets } from '@/api/generated/auth/AuthActivityFacets'
import type { AuthClaimKeys } from '@/api/generated/auth/AuthClaimKeys'
import type { AuthMessageFacets } from '@/api/generated/auth/AuthMessageFacets'
import type { AuthUserFacets } from '@/api/generated/auth/AuthUserFacets'
import { type FacetGroup, facetState, toggleFacet } from '@/components/console/facet-list'
import type { FilterFieldSpec } from '@/components/console/filter-field'
import { type GoldenFile, runGoldenCases } from '@/lib/filter-golden'
import {
  ACTIVITY_FIELDS,
  CALLER_VALUES,
  MESSAGE_FIELDS,
  MESSAGE_KIND_VALUES,
  USER_FIELDS,
  activityFacetGroups,
  activityFields,
  claimSuggestions,
  messageFacetGroups,
  userFacetGroups,
  userFields,
} from './fields'
import activityCases from './filter-cases/activity.json'
import inboxCases from './filter-cases/inbox.json'
import usersCases from './filter-cases/users.json'

describe('the users filter', () => {
  runGoldenCases(usersCases as GoldenFile)
})
describe('the activity filter', () => {
  runGoldenCases(activityCases as GoldenFile)
})
describe('the inbox filter', () => {
  runGoldenCases(inboxCases as GoldenFile)
})

/** A field as the case files write it: lists present only when they say something. */
function asCaseField(field: FilterFieldSpec) {
  return {
    key: field.key,
    ...(field.aliases?.length ? { aliases: [...field.aliases] } : {}),
    kind: field.kind,
    help: field.help,
    ...(field.values?.length ? { values: [...field.values] } : {}),
  }
}

describe('the fields', () => {
  it('are the ones the engine validates with, as the shared case files pin them', () => {
    expect(USER_FIELDS.map(asCaseField)).toEqual((usersCases as GoldenFile).fields)
    expect(ACTIVITY_FIELDS.map(asCaseField)).toEqual((activityCases as GoldenFile).fields)
    expect(MESSAGE_FIELDS.map(asCaseField)).toEqual((inboxCases as GoldenFile).fields)
  })

  it('spell callers and message kinds as the filter does', () => {
    const caller = ACTIVITY_FIELDS.find((field) => field.key === 'caller')
    expect(Object.values(CALLER_VALUES).toSorted()).toEqual([...(caller?.values ?? [])].toSorted())
    const kind = MESSAGE_FIELDS.find((field) => field.key === 'kind')
    expect(Object.values(MESSAGE_KIND_VALUES).toSorted()).toEqual(
      [...(kind?.values ?? [])].toSorted(),
    )
  })
})

const USER_FACETS: AuthUserFacets = {
  disabled: 3,
  unverified: 41,
  anonymous: 12,
  customToken: 4,
  sample: 0,
  mfa: 2,
  claims: 7,
  neverSignedIn: 120,
  providers: [
    { provider: 'password', users: 980 },
    { provider: 'phone', users: 88 },
    { provider: 'google.com', users: 60 },
  ],
}

function facet(groups: FacetGroup[], label: string) {
  const found = groups.flatMap((group) => group.facets).find((entry) => entry.label === label)
  if (!found) throw new Error(`no facet ${label}`)
  return found
}

describe('the users facets', () => {
  const groups = userFacetGroups(USER_FACETS)

  it('are grouped by the keys they write, with breakdowns only', () => {
    expect(groups.map((group) => group.label)).toEqual(['Account', 'Has', 'Not yet', 'Providers'])
    expect(groups.flatMap((group) => group.facets.map((entry) => entry.label))).toEqual([
      'Disabled',
      'Anonymous',
      'Custom token',
      'MFA',
      'Custom claims',
      'Unverified email',
      'Never signed in',
      'password',
      'phone',
      'google.com',
    ])
    expect(facet(groups, 'Unverified email').count).toBe(41)
    expect(facet(groups, 'google.com')).toEqual({
      term: 'provider:google.com',
      label: 'google.com',
      count: 60,
    })
  })

  it('list sample users only when there are some', () => {
    const sampled = userFacetGroups({ ...USER_FACETS, sample: 10_000 })
    expect(facet(sampled, 'Sample users')).toEqual({
      term: 'is:sample',
      label: 'Sample users',
      count: 10_000,
    })
  })

  it('write and remove exactly their terms, the two-term one included', () => {
    const disabled = facet(groups, 'Disabled').term
    const unverified = facet(groups, 'Unverified email').term
    const never = facet(groups, 'Never signed in').term
    let q = 'ada'
    q = toggleFacet(q, disabled)
    expect(q).toBe('ada is:disabled')
    q = toggleFacet(q, unverified)
    expect(q).toBe('ada is:disabled has:email -is:verified')
    q = toggleFacet(q, never)
    expect(q).toBe('ada is:disabled has:email -is:verified -has:sign-in')
    expect(facetState(q, unverified)).toBe('on')
    expect(facetState(q, never)).toBe('on')
    q = toggleFacet(q, unverified)
    expect(q).toBe('ada is:disabled -has:sign-in')
    q = toggleFacet(toggleFacet(q, disabled), never)
    expect(q).toBe('ada')
  })

  it('read their pressed state from the filter, however it was typed', () => {
    const q = '-is:verified p:phone has:email provider:password'
    expect(facetState(q, facet(groups, 'Unverified email').term)).toBe('on')
    expect(facetState(q, facet(groups, 'password').term)).toBe('on')
    expect(facetState(q, facet(groups, 'phone').term)).toBe('off')
    expect(facetState(q, facet(groups, 'Disabled').term)).toBe('off')
  })

  it('show no figures until the engine has counted', () => {
    const empty = userFacetGroups(undefined)
    expect(empty.map((group) => group.label)).toEqual(['Account', 'Has', 'Not yet'])
    expect(empty.flatMap((group) => group.facets.map((entry) => entry.count))).toEqual(
      Array(7).fill(undefined),
    )
  })
})

const ACTIVITY_FACETS: AuthActivityFacets = {
  errors: 48,
  newUsers: 140,
  kinds: [
    { kind: 'sign-in', calls: 612 },
    { kind: 'sign-up', calls: 140 },
    { kind: 'refresh', calls: 420 },
    { kind: 'code', calls: 86 },
    { kind: 'account', calls: 201 },
    { kind: 'config', calls: 0 },
    { kind: 'lookup', calls: 0 },
    { kind: 'other', calls: 0 },
  ],
  callers: [
    { caller: 'client', calls: 1_300 },
    { caller: 'admin', calls: 25 },
    { caller: 'actionLink', calls: 12 },
    { caller: 'accountPicker', calls: 0 },
  ],
}

describe('the activity facets', () => {
  it('group outcome, kind of call and caller, the rare ones only when they happened', () => {
    const groups = activityFacetGroups(ACTIVITY_FACETS)
    expect(groups.map((group) => [group.label, group.facets.map((entry) => entry.term)])).toEqual([
      ['Outcome', ['is:error', 'is:new-user']],
      [
        'Kind of call',
        [
          'kind:sign-in',
          'kind:sign-up',
          'kind:code',
          'kind:account',
          'kind:refresh',
          'kind:config',
        ],
      ],
      ['Caller', ['caller:app', 'caller:admin', 'caller:link']],
    ])
    expect(facet(groups, 'Errors')).toEqual({
      term: 'is:error',
      label: 'Errors',
      count: 48,
      tone: 'danger',
    })
    expect(facet(groups, 'Configuration').count).toBe(0)
  })

  it('keep a pressed rare facet in sight, and list one that happened', () => {
    const groups = activityFacetGroups(
      {
        ...ACTIVITY_FACETS,
        kinds: [...ACTIVITY_FACETS.kinds.slice(0, 6), { kind: 'lookup', calls: 9 }],
      },
      'caller:picker',
    )
    expect(facet(groups, 'Lookups').count).toBe(9)
    expect(facet(groups, 'Account picker')).toEqual({
      term: 'caller:picker',
      label: 'Account picker',
      count: 0,
    })
    expect(toggleFacet('caller:picker is:error', 'caller:picker')).toBe('is:error')
  })
})

const MESSAGE_FACETS: AuthMessageFacets = {
  unused: 3,
  returned: 4,
  restored: 0,
  kinds: [
    { kind: 'passwordReset', messages: 12 },
    { kind: 'smsSignIn', messages: 20 },
    { kind: 'smsMfaSignIn', messages: 5 },
  ],
}

describe('the inbox facets', () => {
  const groups = messageFacetGroups(MESSAGE_FACETS)

  it('write the unused filter as a negation and list the kinds the engine kept', () => {
    expect(groups.map((group) => [group.label, group.facets.map((entry) => entry.term)])).toEqual([
      ['Waiting', ['-is:used']],
      ['Delivery', ['is:returned', 'is:restored']],
      ['Kind', ['kind:reset', 'kind:sms', 'kind:mfa-sign-in']],
    ])
    expect(facet(groups, 'Password reset').count).toBe(12)
  })

  it('press Unused for -is:used and take it out again', () => {
    const unused = facet(groups, 'Unused').term
    expect(toggleFacet('type:sms', unused)).toBe('type:sms -is:used')
    expect(facetState('type:sms -is:used', unused)).toBe('on')
    expect(toggleFacet('type:sms -is:used', unused)).toBe('type:sms')
    // A filter asking for used ones is turned around, not contradicted.
    expect(toggleFacet('is:used', unused)).toBe('-is:used')
  })
})

const CLAIMS: AuthClaimKeys = {
  usersWithClaims: 9,
  keys: [
    { key: 'role', users: 7, kinds: ['string'], samples: ['admin', 'editor'] },
    { key: 'plan', users: 3, kinds: ['string'], samples: ['pro', '3'] },
    { key: 'beta', users: 1, kinds: ['boolean'], samples: [true] },
    { key: 'orgs', users: 1, kinds: ['array'], samples: [['acme']] },
  ],
}

describe('completion', () => {
  it('offers the provider ids users carry, by prefix', () => {
    const provider = userFields({ providers: () => ['password', 'phone', 'google.com'] }).find(
      (field) => field.key === 'provider',
    )
    expect(provider?.suggest?.('p')).toEqual(['password', 'phone'])
    expect(provider?.suggest?.('G')).toEqual(['google.com'])
    const activity = activityFields(() => ['google.com']).find((field) => field.key === 'provider')
    expect(activity?.suggest?.('')).toEqual(['google.com'])
  })

  it('offers claim keys, then the values seen for one, as the engine reads them back', () => {
    expect(claimSuggestions(CLAIMS, '')).toEqual(['role', 'plan', 'beta', 'orgs'])
    expect(claimSuggestions(CLAIMS, 'r')).toEqual(['role'])
    expect(claimSuggestions(CLAIMS, 'role=')).toEqual(['role=admin', 'role=editor'])
    expect(claimSuggestions(CLAIMS, 'role=e')).toEqual(['role=editor'])
    // A string that reads as a number stays a string; a boolean is itself.
    expect(claimSuggestions(CLAIMS, 'plan=')).toEqual(['plan=pro', 'plan="3"'])
    expect(claimSuggestions(CLAIMS, 'beta=')).toEqual(['beta=true'])
    // An array is not a value `claim:` can match.
    expect(claimSuggestions(CLAIMS, 'orgs=')).toEqual([])
    expect(claimSuggestions(undefined, 'r')).toEqual([])
  })

  it('reads the claim keys on each completion, so new figures need no new fields', () => {
    let keys: AuthClaimKeys | undefined
    const claim = userFields({ claims: () => keys }).find((field) => field.key === 'claim')
    expect(claim?.suggest?.('')).toEqual([])
    keys = CLAIMS
    expect(claim?.suggest?.('b')).toEqual(['beta'])
  })

  it('leaves the other fields as they are', () => {
    const fields = userFields({})
    expect(fields.every((field) => field.suggest === undefined)).toBe(true)
    expect(fields.map((field) => field.key)).toEqual(USER_FIELDS.map((field) => field.key))
  })
})
