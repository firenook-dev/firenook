import { describe, expect, it } from 'vitest'
import type { EngineInfo } from '@/api/generated/EngineInfo'
import { REPOSITORY_URL, newIssueUrl, releaseNotesUrl } from './project-links'

const RELEASED: EngineInfo = {
  name: 'Firenook',
  version: '0.2.0-next.2',
  revision: '63d554c15f2699cf623c7fac19a4d1393c77f322',
  consoleBuild: '9a8b7c6d5e4f3a2b',
}

describe('the links out of the console', () => {
  it('opens a released engine’s own notes, and the list for any other build', () => {
    expect(releaseNotesUrl(RELEASED)).toBe(`${REPOSITORY_URL}/releases/tag/npm-v0.2.0-next.2`)
    expect(releaseNotesUrl({ ...RELEASED, version: '0.2.0-local.gfd8c2e181cf7' })).toBe(
      `${REPOSITORY_URL}/releases`,
    )
    expect(releaseNotesUrl({ ...RELEASED, version: null })).toBe(`${REPOSITORY_URL}/releases`)
    expect(releaseNotesUrl(undefined)).toBe(`${REPOSITORY_URL}/releases`)
  })

  it('starts an issue with the engine’s version and source commit in it', () => {
    const url = new URL(newIssueUrl(RELEASED))
    expect(`${url.origin}${url.pathname}`).toBe(`${REPOSITORY_URL}/issues/new`)
    expect(url.searchParams.get('body')).toContain(
      'Firenook 0.2.0-next.2, engine source 63d554c15f26',
    )
    expect(new URL(newIssueUrl(undefined)).searchParams.get('body')).toContain('Firenook …')
  })
})
