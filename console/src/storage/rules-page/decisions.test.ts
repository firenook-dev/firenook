import { describe, expect, it } from 'vitest'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageDecisionWindow } from '@/api/generated/storage/StorageDecisionWindow'
import { folderCompletions } from './folder-field'
import {
  DECISION_CAP,
  EVICTED,
  createDecisionLog,
  decidingLines,
  decisionParams,
  gapText,
  parseDecisionFilter,
  printDecisionFilter,
  whoAsked,
  windowText,
} from './decisions'
import { storageRulesSearch } from './rules-search'

function decision(id: string, patch: Partial<StorageDecision> = {}): StorageDecision {
  return {
    id,
    at: '2026-10-12T09:12:04.000Z',
    bucket: 'demo.appspot.com',
    method: 'get',
    path: 'users/u1/a.png',
    outcome: 'allow',
    error: null,
    uid: 'u1',
    tenant: null,
    provider: 'password',
    anonymous: false,
    allows: [],
    rulesHash: 'h',
    noRuleset: false,
    size: null,
    contentType: null,
    viaConsole: false,
    ...patch,
  }
}

const WINDOW: StorageDecisionWindow = {
  retained: 10_000,
  since: '2026-10-12T09:12:04.000Z',
  reRunnable: 2_000,
  omitted: 0,
}

describe('narrowing the decisions', () => {
  it('becomes the topic’s parameters, which the engine evaluates; absent filters are left out', () => {
    expect(decisionParams('demo.appspot.com', {})).toEqual({ bucket: 'demo.appspot.com' })
    expect(decisionParams(undefined, {})).toEqual({})
    expect(
      decisionParams('b', { path: 'users/', uid: 'u1', denied: true, method: 'create' }),
    ).toEqual({ bucket: 'b', path: 'users/', uid: 'u1', denied: true, method: 'create' })
    // An exact name is a value like any other: the engine tells a folder by its slash.
    expect(decisionParams('b', { path: 'users/u1/a.png', denied: false, uid: '' })).toEqual({
      bucket: 'b',
      path: 'users/u1/a.png',
    })
  })

  it('reads one field’s terms as the path, the uid and the method, and writes them back', () => {
    expect(parseDecisionFilter('')).toEqual({ path: undefined, uid: undefined, method: undefined })
    expect(parseDecisionFilter('users/u1/ uid:u1 create')).toEqual({
      path: 'users/u1/',
      uid: 'u1',
      method: 'create',
    })
    // The order is free; `method:` is the long form; a second path word is ignored.
    expect(parseDecisionFilter('method:LIST  uid:Ada users/ more')).toEqual({
      path: 'users/',
      uid: 'Ada',
      method: 'list',
    })
    // A method word is a method, not a file called "get".
    expect(parseDecisionFilter('get')).toEqual({ path: undefined, uid: undefined, method: 'get' })
    expect(parseDecisionFilter('uid:')).toEqual({
      path: undefined,
      uid: undefined,
      method: undefined,
    })
    expect(printDecisionFilter({ path: 'users/', uid: 'u1', method: 'create' })).toBe(
      'users/ uid:u1 create',
    )
    expect(printDecisionFilter({})).toBe('')
    for (const text of ['users/u1/a.png', 'uid:u1', 'delete', 'public/ uid:u2 update'])
      expect(printDecisionFilter(parseDecisionFilter(text))).toBe(text)
  })

  it('is the rules kit’s schema, with the bucket and a line', () => {
    expect(
      storageRulesSearch.parse({
        bucket: 'demo-media',
        panel: 'folders',
        path: 'users/',
        denied: true,
        method: 'list',
        line: 6,
      }),
    ).toEqual({
      bucket: 'demo-media',
      panel: 'folders',
      path: 'users/',
      denied: true,
      method: 'list',
      line: 6,
    })
    expect(storageRulesSearch.safeParse({ panel: 'collections' }).success).toBe(false)
    expect(storageRulesSearch.safeParse({ line: 0 }).success).toBe(false)
  })
})

describe('the decisions a page keeps', () => {
  it('lists a batch newest first, once each, and keeps the window the engine sent', () => {
    const log = createDecisionLog()
    log.push({ items: [decision('s1'), decision('s2')], window: WINDOW })
    log.push({ items: [decision('s2'), decision('s3')], window: { ...WINDOW, retained: 3 } })
    expect(log.getState().items.map((item) => item.id)).toEqual(['s3', 's2', 's1'])
    expect(log.getState().window?.retained).toBe(3)
    expect(log.getState().heard).toBe(true)
  })

  it('keeps the newest 10,000, as the engine does', () => {
    const log = createDecisionLog()
    const many = Array.from({ length: DECISION_CAP + 5 }, (_, index) => decision(`s${index}`))
    log.push({ items: many, window: WINDOW })
    const items = log.getState().items
    expect(items).toHaveLength(DECISION_CAP)
    expect(items[0]?.id).toBe(`s${DECISION_CAP + 4}`)
    expect(items.at(-1)?.id).toBe('s5')
  })

  it('marks a gap above the newest it held, and forgets a gap whose decision left', () => {
    const log = createDecisionLog(3)
    log.gap(120)
    // Nothing held yet: the replay that follows is everything there is.
    expect(log.getState().gaps.size).toBe(0)
    log.push({ items: [decision('s1')], window: WINDOW })
    log.gap(120)
    log.push({ items: [decision('s9')], window: WINDOW })
    expect([...log.getState().gaps]).toEqual([['s1', 120]])
    log.push({ items: [decision('s10'), decision('s11')], window: WINDOW })
    expect(log.getState().items.map((item) => item.id)).toEqual(['s11', 's10', 's9'])
    expect(log.getState().gaps.size).toBe(0)
  })

  it('starts again for another question, and only then', () => {
    const log = createDecisionLog()
    log.answer('{"bucket":"b"}')
    log.push({ items: [decision('s1')], window: WINDOW })
    log.answer('{"bucket":"b"}')
    expect(log.getState().items).toHaveLength(1)
    log.answer('{"bucket":"b","denied":true}')
    expect(log.getState().items).toHaveLength(0)
    expect(log.getState().heard).toBe(false)
    expect(log.getState().question).toBe('{"bucket":"b","denied":true}')
  })
})

describe('what the panel says', () => {
  it('names the window the engine holds', () => {
    expect(windowText(WINDOW, 'utc')).toBe(
      'Holding the last 10,000 decisions, since 2026-10-12T09:12:04.000Z · the newest 2,000 can be re-run',
    )
    expect(windowText({ ...WINDOW, retained: 5, reRunnable: 5 }, 'utc')).toBe(
      'Holding the last 5 decisions, since 2026-10-12T09:12:04.000Z · every one can be re-run',
    )
    expect(windowText({ ...WINDOW, omitted: 12 }, 'utc')).toContain(
      '12 were not recorded while the engine was busy',
    )
    expect(windowText({ ...WINDOW, retained: 0 })).toBeUndefined()
    expect(windowText(undefined)).toBeUndefined()
  })

  it('says how many a gap lost, and why a decision cannot be explained any more', () => {
    expect(gapText(1)).toBe(
      '1 decision was missed here: this tab was away longer than the engine keeps them.',
    )
    expect(gapText(3120)).toMatch(/^3,120 decisions were missed here/)
    expect(gapText(null)).toMatch(/^Some decisions were missed here/)
    expect(EVICTED).toContain('it keeps the newest 2,000')
  })

  it('names who asked, and the lines that decided it', () => {
    expect(whoAsked(decision('s1'))).toBe('u1')
    expect(whoAsked(decision('s1', { tenant: 'team-a' }))).toBe('u1 · team-a')
    expect(whoAsked(decision('s1', { uid: null, anonymous: true }))).toBe('not signed in')
    const allows = [
      { line: 5, from: 0, to: 1, outcome: 'deny' as const },
      { line: 6, from: 2, to: 3, outcome: 'allow' as const },
      { line: 6, from: 2, to: 3, outcome: 'allow' as const },
    ]
    expect(decidingLines({ allows, outcome: 'allow' })).toEqual([6])
    expect(decidingLines({ allows, outcome: 'deny' })).toEqual([5])
  })
})

describe('folder completion', () => {
  it('offers the folders under what is typed that continue it', () => {
    const children = ['u_ada', 'u_grace', 'public', 'U_Upper']
    expect(folderCompletions('users/u_', children)).toEqual([
      'users/u_ada/',
      'users/u_grace/',
      'users/U_Upper/',
    ])
    expect(folderCompletions('pu', children)).toEqual(['public/'])
    // Typed up to a slash: the folders inside it.
    expect(folderCompletions('users/', ['u_ada'])).toEqual(['users/u_ada/'])
  })
})
