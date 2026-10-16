import { describe, expect, it } from 'vitest'
import type { EngineInfo } from '@/api/generated/EngineInfo'
import { engineBuild, engineVersion, engineVersionShort } from './engine'

const RELEASED: EngineInfo = {
  name: 'Firenook',
  version: '0.2.0-next.2',
  revision: '63d554c15f2699cf623c7fac19a4d1393c77f322',
  consoleBuild: '9a8b7c6d5e4f3a2b',
}

describe('how the console names the engine', () => {
  it('shows the release the launcher declared', () => {
    expect(engineVersion(RELEASED)).toBe('0.2.0-next.2')
    expect(engineBuild(RELEASED)).toBe('Firenook 0.2.0-next.2, engine source 63d554c15f26')
  })

  it('says a build is unreleased rather than inventing a version', () => {
    const built: EngineInfo = {
      name: 'Firenook',
      version: null,
      revision: null,
      consoleBuild: 'unbuilt',
    }
    expect(engineVersion(built)).toBe('unreleased build')
    expect(engineVersion(built)).not.toContain('0.0.1')
    expect(engineBuild(built)).toBeUndefined()
  })

  it('names the build when only the source commit is known', () => {
    const built: EngineInfo = { ...RELEASED, version: null }
    expect(engineBuild(built)).toBe('Firenook unreleased build, engine source 63d554c15f26')
  })

  it('waits rather than guessing before the status answers', () => {
    expect(engineVersion(undefined)).toBe('…')
    expect(engineBuild(undefined)).toBeUndefined()
  })

  it('writes the version short for the sidebar, a local build’s commit left out', () => {
    expect(engineVersionShort(RELEASED)).toBe('v0.2.0-next.2')
    expect(engineVersionShort({ ...RELEASED, version: '0.2.0-local.gfd8c2e181cf7' })).toBe(
      'v0.2.0-local',
    )
    expect(engineVersionShort({ ...RELEASED, version: null })).toBe('unreleased build')
    expect(engineVersionShort(undefined)).toBe('…')
  })
})
