import { describe, expect, it } from 'vitest'
import { resolveConsoleProject, scopesByProject } from './project'

describe('the project a page shows', () => {
  it('is the configured one unless the link asks for another', () => {
    expect(
      resolveConsoleProject({ configured: 'demo-x', requested: undefined, scoped: true }),
    ).toEqual({ project: 'demo-x', foreign: false })
    expect(
      resolveConsoleProject({ configured: 'demo-x', requested: 'my-prod', scoped: true }),
    ).toEqual({ project: 'my-prod', foreign: true })
  })

  it('ignores ?project= on a section that does not scope by project', () => {
    expect(
      resolveConsoleProject({ configured: 'demo-x', requested: 'my-prod', scoped: false }),
    ).toEqual({ project: 'demo-x', foreign: false })
  })

  it('does not call the configured project foreign when it is asked for by name', () => {
    expect(
      resolveConsoleProject({ configured: 'demo-x', requested: 'demo-x', scoped: true }),
    ).toEqual({ project: 'demo-x', foreign: false })
  })

  it('answers before the status arrives', () => {
    expect(
      resolveConsoleProject({ configured: undefined, requested: undefined, scoped: true }),
    ).toEqual({ project: '', foreign: false })
    expect(
      resolveConsoleProject({ configured: undefined, requested: 'my-prod', scoped: true }),
    ).toEqual({ project: 'my-prod', foreign: true })
  })

  it('knows which sections scope by project', () => {
    expect(scopesByProject('/firestore')).toBe(true)
    expect(scopesByProject('/firestore/rules')).toBe(true)
    expect(scopesByProject('/auth')).toBe(true)
    expect(scopesByProject('/pubsub')).toBe(true)
    expect(scopesByProject('/tasks')).toBe(true)
    expect(scopesByProject('/storage')).toBe(false)
    expect(scopesByProject('/functions')).toBe(false)
    expect(scopesByProject('/')).toBe(false)
    expect(scopesByProject('/authentic')).toBe(false)
  })
})
