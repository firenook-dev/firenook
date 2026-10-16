import { describe, expect, it } from 'vitest'
import { LOG_KINDS } from '@/api/generated/observe/logKinds'
import {
  INTERNAL_FACET_LABEL,
  KIND_FACET_LABELS,
  isInternalKind,
  isMarkerKind,
  isProblemKind,
  isProblemLine,
  kindFacetLabel,
  kindFacets,
  kindGroup,
  kindInfo,
  kindLabel,
} from './kinds'

describe('log kinds', () => {
  it('give every kind the engine lists a label, and a facet label', () => {
    for (const info of LOG_KINDS) {
      expect(kindLabel(info.kind), info.kind).toBe(info.label)
      expect(kindLabel(info.kind).length, info.kind).toBeGreaterThan(0)
      expect(kindFacetLabel(info.kind).length, info.kind).toBeGreaterThan(0)
    }
  })

  it('write a plural only for kinds the engine lists, and none for its internals', () => {
    const listed = new Map(LOG_KINDS.map((info) => [info.kind, info]))
    for (const kind of Object.keys(KIND_FACET_LABELS)) {
      expect(listed.has(kind), `${kind} is not a kind the engine lists`).toBe(true)
      expect(listed.get(kind)?.internal, `${kind} is an engine internal`).toBe(false)
    }
    // Every problem kind reads as what went wrong, in the facet's words.
    for (const info of LOG_KINDS.filter((each) => each.problem))
      expect(KIND_FACET_LABELS[info.kind], info.kind).toBeDefined()
  })

  it('read the problem, marker and internal sets from the engine', () => {
    for (const info of LOG_KINDS) {
      expect(isProblemKind(info.kind), info.kind).toBe(info.problem)
      expect(isMarkerKind(info.kind), info.kind).toBe(info.marker)
      expect(isInternalKind(info.kind), info.kind).toBe(info.internal)
    }
    expect(kindGroup('rules.denied')).toBe('problem')
    expect(kindGroup('functions.reloaded')).toBe('marker')
    expect(kindGroup('engine.configured')).toBe('internal')
    expect(kindGroup('function.start')).toBe('plain')
    expect(kindGroup(undefined)).toBe('plain')
    expect(kindGroup(null)).toBe('plain')
  })

  it('label the facet rows in English, every internal as one row', () => {
    expect(kindFacetLabel('rules.denied')).toBe('Rules denials')
    expect(kindFacetLabel('function.failed')).toBe('Function failures')
    expect(kindFacetLabel('function.timeout')).toBe('Timeouts')
    expect(kindFacetLabel('functions.reloaded')).toBe('Functions reloads')
    expect(kindFacetLabel('auth.message')).toBe('Auth codes and links')
    expect(kindFacetLabel('engine.configured')).toBe(INTERNAL_FACET_LABEL)
    expect(kindFacetLabel('functions.receipt')).toBe('Engine internals')
  })

  it('keep a kind the engine adds later readable', () => {
    expect(kindInfo('compute.newThing')).toBeUndefined()
    expect(kindLabel('compute.newThing')).toBe('compute.newThing')
    expect(kindFacetLabel('compute.newThing')).toBe('compute.newThing')
    expect(kindGroup('compute.newThing')).toBe('plain')
  })

  it('count a line as a problem when it is an error or of a problem kind', () => {
    expect(isProblemLine({ level: 'error' })).toBe(true)
    expect(isProblemLine({ level: 'warn', kind: 'rules.denied' })).toBe(true)
    expect(isProblemLine({ level: 'info', kind: 'rules.denied.console' })).toBe(false)
    expect(isProblemLine({ level: 'warn' })).toBe(false)
    expect(isProblemLine({ level: 'info', kind: null })).toBe(false)
  })

  it('order the Kind facet: problems, then the rest, the internals summed last', () => {
    const facets = kindFacets(
      [
        { value: 'function.start', count: 40 },
        { value: 'rules.denied', count: 12 },
        { value: 'functions.receipt', count: 3 },
        { value: 'function.failed', count: 2 },
        { value: 'functions.reloaded', count: 1 },
        { value: 'engine.configured', count: 6 },
        { value: 'function.timeout', count: 0 },
      ],
      0,
    )
    expect(facets.problems.map((count) => count.value)).toEqual(['rules.denied', 'function.failed'])
    expect(facets.others.map((count) => count.value)).toEqual([
      'function.start',
      'functions.reloaded',
    ])
    expect(facets.internal).toBe(9)
  })

  it('take the internals the default filter left out from the engine', () => {
    const facets = kindFacets([{ value: 'rules.denied', count: 2 }], 6)
    expect(facets.internal).toBe(6)
    expect(facets.problems).toEqual([{ value: 'rules.denied', count: 2 }])
  })
})
