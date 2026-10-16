import { describe, expect, it } from 'vitest'
import { checkFilter } from '@/lib/filter'
import { LOG_FIELDS } from './fields'
import {
  LEVEL_VIEWS,
  addTerm,
  executionTerm,
  flipLevelView,
  hideLikeTerm,
  payloadTerm,
  phraseTerm,
} from './terms'

const parses = (q: string) => checkFilter(q, { fields: LOG_FIELDS, regex: true }).ok

describe('the items the page writes', () => {
  it('filters a payload value: strings quoted, the rest as JSON, the path’s case kept', () => {
    expect(payloadTerm(['cartId'], 'c_19')).toBe('payload.cartId:"c_19"')
    expect(payloadTerm(['cart', 'items', 0, 'sku'], 'A-1')).toBe('payload.cart.items.0.sku:"A-1"')
    expect(payloadTerm(['count'], 3)).toBe('payload.count:3')
    expect(payloadTerm(['ok'], false)).toBe('payload.ok:false')
    expect(payloadTerm(['gone'], null)).toBe('payload.gone:null')
    expect(payloadTerm(['say'], 'he said "hi"')).toBe('payload.say:"he said \\"hi\\""')
    expect(payloadTerm(['a.b'], 'x')).toBeUndefined()
    expect(payloadTerm(['items'], [])).toBeUndefined()
    expect(phraseTerm('x y')).toBe('"x y"')
    for (const term of ['payload.cartId:"c_19"', 'payload.count:3', 'payload.gone:null'])
      expect(parses(term), term).toBe(true)
  })

  it('hides lines like one by its first line’s first 60 characters', () => {
    expect(hideLikeTerm('heartbeat ok')).toBe('-"heartbeat ok"')
    expect(hideLikeTerm('TypeError: x\n  at y')).toBe('-"TypeError: x"')
    const long = 'a'.repeat(80)
    expect(hideLikeTerm(long)).toBe(`-"${'a'.repeat(60)}"`)
    expect(parses(hideLikeTerm('say "hi" /now/'))).toBe(true)
  })

  it('shows one invocation, and adds an item once, after what is typed', () => {
    expect(executionTerm('a3f9c1-1284')).toBe('execution:a3f9c1-1284')
    expect(addTerm('', 'level:error')).toBe('level:error')
    expect(addTerm('burst  ', 'level:error')).toBe('burst level:error')
    expect(addTerm('burst level:error', 'level:error')).toBe('burst level:error')
  })

  it('flips to a level view and back to the filter it replaced', () => {
    const on = flipLevelView('function:hello', LEVEL_VIEWS.errors, undefined)
    expect(on).toEqual({ q: 'level:error', previous: 'function:hello' })
    expect(flipLevelView(on.q, LEVEL_VIEWS.errors, on.previous)).toEqual({
      q: 'function:hello',
      previous: undefined,
    })
    expect(flipLevelView('level:error', LEVEL_VIEWS.problems, 'x').q).toBe('level:warn level:error')
  })
})
