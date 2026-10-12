import { describe, expect, it } from 'vitest'
import { connectSnippet } from '@/lib/connect'
import { testStatus } from '@/test/status'
import { CONNECT_TABS, connectDialects } from './components/connect-card'
import { retentionText } from './components/data-card'
import { blockingFunctionId, forwarded } from './components/hooks-card'

/** An engine on this machine running Auth on 39099. */
const status = testStatus({
  projectId: 'demo-auth',
  services: [{ name: 'auth', host: '127.0.0.1', port: 39099, listening: true, pid: null }],
})

describe('the Connect card', () => {
  it('prints lib/connect.ts’s snippets for auth and holds none of its own', () => {
    const dialects = connectDialects(status, '127.0.0.1')
    expect(dialects.map((dialect) => dialect.id)).toEqual(CONNECT_TABS.map((tab) => tab.id))
    for (const tab of CONNECT_TABS) {
      if (tab.id === 'android') continue
      const shown = dialects.find((dialect) => dialect.id === tab.id)
      expect(shown?.code).toBe(connectSnippet(tab.id, { services: ['auth'], status }))
    }
    expect(dialects[0]?.code).toContain(
      "connectAuthEmulator(getAuth(app), 'http://127.0.0.1:39099')",
    )
  })

  it('points Android at 10.0.2.2 when the engine listens on loopback', () => {
    const android = connectDialects(status, '127.0.0.1').find((dialect) => dialect.id === 'android')
    expect(android?.code).toBe(
      connectSnippet('android', { services: ['auth'], status, host: '10.0.2.2' }),
    )
    expect(android?.code).toContain('Firebase.auth.useEmulator("10.0.2.2", 39099)')
  })
})

describe('the other Settings cards', () => {
  it('name a blocking function as Functions does', () => {
    expect(blockingFunctionId('http://127.0.0.1:5001/demo-auth/us-central1/beforeCreate')).toBe(
      'us-central1-beforeCreate',
    )
    expect(blockingFunctionId('https://example.test/hook')).toBeUndefined()
    expect(blockingFunctionId('not a url')).toBeUndefined()
    expect(
      forwarded({ forwardIdToken: true, forwardAccessToken: false, forwardRefreshToken: true }),
    ).toBe('forwards idToken, refreshToken')
    expect(
      forwarded({ forwardIdToken: false, forwardAccessToken: false, forwardRefreshToken: false }),
    ).toBeUndefined()
  })

  it('say what the engine keeps', () => {
    expect(
      retentionText({ messageCapacity: 2_000, activityCapacity: 10_000, bodiesRetained: true }),
    ).toBe(
      'The Inbox keeps the newest 2,000 messages and Activity the newest 10,000 calls; request bodies are kept, in memory only (--no-diagnostics turns that off).',
    )
    expect(
      retentionText({ messageCapacity: 2_000, activityCapacity: 10_000, bodiesRetained: false }),
    ).toContain('not kept')
  })
})
