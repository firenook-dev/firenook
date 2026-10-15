import { describe, expect, it } from 'vitest'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import { parseViewAs } from '@/lib/identity'
import { auth } from '@/lib/sections/auth'
import { authActions } from '@/lib/sections/auth-actions'
import {
  ACTION_PATH,
  activityLink,
  callLink,
  callRef,
  consoleActionLink,
  firestoreAsUser,
  logsForCall,
  messageLink,
  messageRef,
  playgroundAsUser,
  rulesDecisionsLink,
  userLink,
  userRef,
  userTraceLinks,
} from './links'

const route = (kind: string, key: string) => auth.routes?.[kind]?.(key)

describe('where Authentication things open', () => {
  it('a project user on the Users page with the inspector on them', () => {
    expect(route('auth.user', '|u_9f3k2')).toEqual({
      to: '/auth',
      search: { tenant: undefined, user: 'u_9f3k2' },
    })
  })

  it('a tenant user in their tenant', () => {
    expect(route('auth.user', 'acme|u_1')).toEqual({
      to: '/auth',
      search: { tenant: 'acme', user: 'u_1' },
    })
  })

  it('a uid holding a bar, a slash or a percent sign, whole', () => {
    expect(route('auth.user', 'acme|a|b')).toEqual({
      to: '/auth',
      search: { tenant: 'acme', user: 'a|b' },
    })
    expect(route('auth.user', '|team/42%x')).toEqual({
      to: '/auth',
      search: { tenant: undefined, user: 'team/42%x' },
    })
    expect(route('auth.user', '||lead')).toEqual({
      to: '/auth',
      search: { tenant: undefined, user: '|lead' },
    })
  })

  it('a key without a bar as a project user', () => {
    expect(route('auth.user', 'u_9f3k2')).toEqual({
      to: '/auth',
      search: { tenant: undefined, user: 'u_9f3k2' },
    })
  })

  it('a call in Activity and a message in the Inbox', () => {
    expect(route('auth.call', '1284')).toEqual({ to: '/auth/activity', search: { entry: '1284' } })
    expect(route('auth.message', '312')).toEqual({ to: '/auth/inbox', search: { message: '312' } })
  })

  it('names its kinds for ⌘K, its pages and its project scope', () => {
    expect(auth.searchLabels).toEqual({ 'auth.user': 'Users' })
    expect(auth.projectScope).toBe(true)
    expect(auth.pages?.map((page) => page.to)).toEqual([
      '/auth',
      '/auth/inbox',
      '/auth/activity',
      '/auth/settings',
    ])
    expect(auth.pages?.[1]?.badges).toEqual(['auth.inbox'])
    expect(authActions.map((action) => action.link)).toEqual([
      { to: '/auth', search: { new: 'user' } },
      { to: '/auth', search: { new: 'import' } },
      { to: '/auth', search: { new: 'sample' } },
      { to: '/auth/activity', search: { panel: 'inspect' } },
      { to: '/auth/settings', search: { new: 'tenant' } },
    ])
  })
})

describe('Auth refs and links', () => {
  it('build the keys the engine builds, and open through the registry', () => {
    expect(userRef(null, 'u_1')).toEqual({ kind: 'auth.user', key: '|u_1' })
    expect(userRef('acme', 'a|b', 'ada@example.test')).toEqual({
      kind: 'auth.user',
      key: 'acme|a|b',
      label: 'ada@example.test',
    })
    expect(userRef(undefined, 'u_1', 'u_1')).toEqual({ kind: 'auth.user', key: '|u_1' })
    expect(callRef(7)).toEqual({ kind: 'auth.call', key: '7' })
    expect(messageRef(9, 'SMS code')).toEqual({ kind: 'auth.message', key: '9', label: 'SMS code' })
    expect(userLink('acme', 'a|b')).toEqual({
      to: '/auth',
      search: { tenant: 'acme', user: 'a|b' },
    })
    expect(callLink(7)).toEqual({ to: '/auth/activity', search: { entry: '7' } })
    expect(messageLink(9)).toEqual({ to: '/auth/inbox', search: { message: '9' } })
  })

  it('filter Activity with the terms they are given', () => {
    expect(activityLink({ q: 'has:blocking' })).toEqual({
      to: '/auth/activity',
      search: { q: 'has:blocking' },
    })
    expect(activityLink({ q: 'uid:u_1', tenant: 'acme' })).toEqual({
      to: '/auth/activity',
      search: { q: 'uid:u_1', tenant: 'acme' },
    })
    expect(activityLink({})).toEqual({ to: '/auth/activity' })
  })

  it('lead from a user to their calls, messages and rules decisions', () => {
    expect(userTraceLinks({ tenant: undefined, uid: 'u_ada' })).toEqual({
      calls: { to: '/auth/activity', search: { q: 'uid:u_ada', tenant: '(none)' } },
      messages: { to: '/auth/inbox', search: { q: 'uid:u_ada', tenant: '(none)' } },
      decisions: {
        to: '/firestore/rules',
        search: { db: undefined, panel: 'decisions', uid: 'u_ada' },
      },
    })
    // A tenant's user, in another project, with a uid the grammar quotes.
    const traced = userTraceLinks({ project: 'my-prod', tenant: 'acme', uid: 'a b' })
    expect(traced.calls).toEqual({
      to: '/auth/activity',
      search: { q: 'uid:"a b"', tenant: 'acme', project: 'my-prod' },
    })
    expect(traced.messages.to).toBe('/auth/inbox')
  })
})

describe('as this user, elsewhere', () => {
  it('opens Firestore and the playground through the serialized identity', () => {
    const link = firestoreAsUser({ uid: 'u:1|x', tenant: 'acme', email: 'ada@example.test' })
    expect(link.to).toBe('/firestore')
    expect(parseViewAs(link.search?.as as string)).toEqual({
      kind: 'user',
      uid: 'u:1|x',
      tenant: 'acme',
      email: 'ada@example.test',
    })
    const playground = playgroundAsUser({ uid: 'u_1', tenant: null, email: null })
    expect(playground).toEqual({
      to: '/firestore/rules',
      search: { panel: 'playground', as: 'u_1' },
    })
  })
})

describe('the rules pages', () => {
  it("a user's rules decisions", () => {
    expect(rulesDecisionsLink('u_ada')).toEqual({
      to: '/firestore/rules',
      search: { db: undefined, panel: 'decisions', uid: 'u_ada' },
    })
  })
})

const CALL: Pick<AuthActivitySummary, 'at' | 'durationMicros' | 'steps'> = {
  at: '2026-10-12T10:02:11.204Z',
  durationMicros: 41_000,
  steps: [],
}

describe('Logs for a call', () => {
  it("opens the blocking function's lines by invocation", () => {
    expect(
      logsForCall({
        ...CALL,
        steps: [
          {
            kind: 'blocking',
            event: 'beforeCreate',
            function: 'beforeCreate',
            uri: 'http://127.0.0.1/beforeCreate',
            durationMicros: 41_000,
            invocation: 'inv-7',
            changed: [],
            customClaims: [],
            sessionClaims: [],
            failure: null,
          },
        ],
      }),
    ).toEqual({ to: '/logs', search: { q: 'execution:inv-7' } })
  })

  it("else the Auth lines around the call's time", () => {
    expect(logsForCall(CALL)).toEqual({
      to: '/logs',
      search: {
        q: 'service:auth',
        from: '2026-10-12T10:02:09.204Z',
        to: '2026-10-12T10:02:13.245Z',
      },
    })
  })
})

describe('email links', () => {
  it('open through the console, the query kept and the Auth port left out', () => {
    expect(
      consoleActionLink(
        'http://127.0.0.1:9099/emulator/action?mode=resetPassword&lang=en&oobCode=k3J&apiKey=fake-api-key',
        'https://console.example',
      ),
    ).toBe(
      `https://console.example${ACTION_PATH}?mode=resetPassword&lang=en&oobCode=k3J&apiKey=fake-api-key`,
    )
  })

  it('for every mode, a tenant included', () => {
    for (const mode of ['verifyEmail', 'signIn', 'verifyAndChangeEmail', 'recoverEmail'])
      expect(
        consoleActionLink(
          `http://localhost:39099/emulator/action?mode=${mode}&oobCode=c&tenantId=acme&continueUrl=https%3A%2F%2Fapp.example%2Ffinish`,
          'http://127.0.0.1:4000',
        ),
      ).toBe(
        `http://127.0.0.1:4000/console/api/v1/auth/emulator/action?mode=${mode}&oobCode=c&tenantId=acme&continueUrl=https%3A%2F%2Fapp.example%2Ffinish`,
      )
  })

  it('leaves text that is not a link as it is', () => {
    expect(consoleActionLink('not a link', 'http://127.0.0.1:4000')).toBe('not a link')
  })
})
