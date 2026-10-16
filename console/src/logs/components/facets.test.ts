import { describe, expect, it } from 'vitest'
import type { LogFacets } from '@/api/generated/observe/LogFacets'
import { facetGroups, hasFacetTerms, withoutFacetTerms } from './facets-panel'
import { hiddenBy, hiddenSentence } from './no-lines'

const FACETS: LogFacets = {
  kept: 1_210,
  matched: 0,
  levels: [
    { value: 'debug', count: 14 },
    { value: 'info', count: 1_180 },
    { value: 'warn', count: 18 },
    { value: 'error', count: 3 },
  ],
  services: [
    { value: 'functions', count: 1_170 },
    { value: 'firestore', count: 21 },
  ],
  functions: [
    { value: 'us-central1-hello', count: 1_180 },
    { value: 'Other', count: 2 },
  ],
  instances: [],
  codebases: [{ value: 'default', count: 1_180 }],
  kinds: [
    { value: 'function.start', count: 40 },
    { value: 'rules.denied', count: 2 },
    { value: 'engine.configured', count: 3 },
  ],
  internalHidden: 6,
  logged: 1_210,
  lastReload: null,
}

describe('the facets panel', () => {
  it('draws Level always, Kind with problems first and internals last, services when more than one', () => {
    const { level, rest, functions } = facetGroups(FACETS)
    expect(level.facets.map((facet) => [facet.term, facet.count])).toEqual([
      ['level:debug', 14],
      ['level:info', 1_180],
      ['level:warn', 18],
      ['level:error', 3],
    ])
    expect(level.facets.map((facet) => facet.tone)).toEqual([
      undefined,
      undefined,
      'warning',
      'danger',
    ])
    const [kind, service] = rest
    expect(kind?.label).toBe('Kind')
    expect(kind?.facets.map((facet) => [facet.label, facet.term, facet.count])).toEqual([
      ['Rules denials', 'kind:rules.denied', 2],
      ['Function starts', 'kind:function.start', 40],
      ['Engine internals', 'is:internal', 9],
    ])
    expect(service?.facets.map((facet) => facet.term)).toEqual([
      'service:functions',
      'service:firestore',
    ])
    // "Other" (past the engine's labels) is not a value a filter can name.
    expect(functions.map((facet) => facet.term)).toEqual(['function:us-central1-hello'])
  })

  it('draws no counts it does not have', () => {
    const { level, rest } = facetGroups(undefined)
    expect(level.facets.every((facet) => facet.count === undefined)).toBe(true)
    expect(rest).toEqual([])
  })

  it('resets what it wrote and keeps the rest as typed', () => {
    const q = 'level:error burst -service:pubsub "heartbeat ok" kind:rules.* payload.a:1'
    expect(hasFacetTerms(q)).toBe(true)
    expect(withoutFacetTerms(q)).toBe('burst "heartbeat ok" payload.a:1')
    expect(hasFacetTerms('burst payload.a:1')).toBe(false)
  })
})

describe('nothing matches', () => {
  it('says which filter hides how many lines, and the internals left out', () => {
    const hidden = hiddenBy('function:us-central1-hello level:error burst', {
      ...FACETS,
      matched: 0,
      functions: [{ value: 'us-central1-hello', count: 12 }],
      levels: FACETS.levels.map((count) =>
        count.value === 'error' ? { value: count.value, count: 0 } : count,
      ),
    })
    expect(hidden).toEqual([
      { what: 'the level filter', lines: 1_212 },
      { what: 'function:us-central1-hello', lines: 12 },
    ])
    expect(hiddenSentence(hidden, 6)).toBe(
      '1,212 lines are hidden by the level filter, 12 by function:us-central1-hello, 6 engine internals.',
    )
    expect(hiddenSentence([], 1)).toBe('1 engine internal is left out.')
    expect(hiddenSentence([], 0)).toBeUndefined()
  })
})
