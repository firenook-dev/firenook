import { describe, expect, it } from 'vitest'
import type { LogFacets } from '@/api/generated/observe/LogFacets'
import { hideFacet, onlyFacet, toggleFacet } from '@/components/console/facet-list'
import { checkFilter, printFilter } from '@/lib/filter'
import { type GoldenFile, runGoldenCases } from '@/lib/filter-golden.test-support'
import { LOG_FIELDS, logFields } from './fields'
import cases from './filter-cases.json'

const golden = cases as GoldenFile

describe('the Logs filter’s golden cases, as the engine runs them', () => {
  const count = runGoldenCases(golden)
  it('holds at least forty cases', () => {
    expect(count).toBeGreaterThanOrEqual(40)
  })
})

describe('the Logs fields', () => {
  it('are the cases file’s own, key for key, in the engine’s order', () => {
    const declared = LOG_FIELDS.map((field) => ({
      key: field.key,
      ...(field.aliases ? { aliases: [...field.aliases] } : {}),
      kind: field.kind,
      help: field.help,
      ...(field.values ? { values: [...field.values] } : {}),
      ...(field.prefixes ? { prefixes: [...field.prefixes] } : {}),
    }))
    expect(declared).toEqual(golden.fields)
  })

  it('complete functions, instances and codebases from the facets, and every kind', () => {
    const facets = {
      functions: [
        { value: 'us-central1-hello', count: 9 },
        { value: 'us-central1-fails', count: 2 },
        { value: 'Other', count: 1 },
      ],
      instances: [{ value: 'resize-images', count: 3 }],
      codebases: [{ value: 'default', count: 12 }],
      kinds: [{ value: 'rules.denied', count: 2 }],
    } as unknown as LogFacets
    const fields = logFields(facets)
    // The Logs suggestions answer at once, from what the page holds.
    const suggest = (key: string, prefix: string) =>
      fields.find((field) => field.key === key)?.suggest?.(prefix) as readonly string[] | undefined
    expect(suggest('function', 'us-central1-h')).toEqual(['us-central1-hello'])
    expect(suggest('function', '')).toEqual(['us-central1-hello', 'us-central1-fails'])
    expect(suggest('instance', '')).toEqual(['resize-images'])
    expect(suggest('codebase', 'DEF')).toEqual(['default'])
    const kinds = suggest('kind', 'rules.') ?? []
    expect(kinds[0]).toBe('rules.denied')
    expect(kinds).toContain('rules.applied')
    expect(suggest('level', '')).toBeUndefined()
  })
})

describe('facet edits', () => {
  const set = { fields: LOG_FIELDS, regex: true }
  /** An edit's result parses, and prints back to itself. */
  const holds = (q: string) => {
    const result = checkFilter(q, set)
    expect(result.ok, q).toBe(true)
    if (result.ok) expect(printFilter(result.query, true)).toBe(q)
  }

  it('toggle, only and hide write terms that print back to themselves', () => {
    const typed = 'burst -"heartbeat ok" /timed? out/i'
    const on = toggleFacet(typed, 'level:error')
    expect(on).toBe('burst -"heartbeat ok" /timed? out/i level:error')
    holds(on)
    const both = toggleFacet(on, 'level:warn')
    holds(both)
    expect(toggleFacet(both, 'level:error')).toBe('burst -"heartbeat ok" /timed? out/i level:warn')
    const only = onlyFacet(both, 'level:debug', [
      { term: 'level:warn', label: 'Warning' },
      { term: 'level:error', label: 'Error' },
    ])
    expect(only).toBe('burst -"heartbeat ok" /timed? out/i level:debug')
    holds(only)
    const hidden = hideFacet(typed, 'service:pubsub')
    expect(hidden).toBe('burst -"heartbeat ok" /timed? out/i -service:pubsub')
    holds(hidden)
    holds(toggleFacet('', 'is:internal'))
    holds(toggleFacet('', 'kind:rules.denied'))
  })
})
