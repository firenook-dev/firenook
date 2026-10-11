import { describe, expect, it } from 'vitest'
import type { EngineInfo } from '@/api/generated/EngineInfo'
import { engineBuild, engineVersion } from './engine'

const RELEASED: EngineInfo = {
  name: 'Firenook',
  version: '0.2.0-next.2',
  revision: '63d554c15f2699cf623c7fac19a4d1393c77f322',
}

describe('how the console names the engine', () => {
  it('shows the release the launcher declared', () => {
    expect(engineVersion(RELEASED)).toBe('0.2.0-next.2')
    expect(engineBuild(RELEASED)).toBe('Firenook 0.2.0-next.2, engine source 63d554c15f26')
  })

  it('says a build is unreleased rather than inventing a version', () => {
    const built: EngineInfo = { name: 'Firenook', version: null, revision: null }
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
})
