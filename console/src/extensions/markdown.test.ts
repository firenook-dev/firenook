// What becomes of an author's HTML (scripts, handlers, `javascript:` links
// dropped; console links marked, others opened in a new tab) is measured in
// a real browser by the extensions journey: DOMPurify walks the document
// with the DOM's own iterators, which the test DOM does not reproduce.

import { describe, expect, it } from 'vitest'
import { consolePath } from './markdown'

describe('which links are the console’s', () => {
  it('a /console/ path, relative or on this origin', () => {
    expect(consolePath('/console/firestore', 'http://127.0.0.1:4000')).toBe('/firestore')
    expect(
      consolePath('http://127.0.0.1:4000/console/auth?tenant=t', 'http://127.0.0.1:4000'),
    ).toBe('/auth?tenant=t')
  })

  it('not the engine’s API, another origin or a path outside the console', () => {
    expect(consolePath('/console/api/v1/status', 'http://127.0.0.1:4000')).toBeUndefined()
    expect(consolePath('/console/api', 'http://127.0.0.1:4000')).toBeUndefined()
    expect(consolePath('https://example.com/console/x', 'http://127.0.0.1:4000')).toBeUndefined()
    expect(consolePath('/firestore', 'http://127.0.0.1:4000')).toBeUndefined()
    expect(consolePath('#usage', 'http://127.0.0.1:4000')).toBeUndefined()
  })
})
