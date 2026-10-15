import { describe, expect, it } from 'vitest'
import { blockingFunctionId, forwarded } from './components/hooks-card'

describe('the blocking functions card', () => {
  it('names a blocking function as Functions does', () => {
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
})
