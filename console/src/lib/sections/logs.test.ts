import { describe, expect, it } from 'vitest'
import { type FilterFieldSet, checkFilter } from '@/lib/filter'
import cases from '@/logs/filter-cases.json'
import { LOGS_LINK_KEYS, linkToLogs, logs } from './logs'

// The Logs fields as the engine declares them (the cases file mirrors
// `LOG_FIELDS`, and the engine's own test pins it).
const LOG_FIELDS: FilterFieldSet = { fields: cases.fields as never, regex: true }

/** What `q` means to the Logs filter: its terms as key and value. */
function terms(q: string | number | boolean | undefined): [string, string][] {
  if (typeof q !== 'string') throw new Error(`no q in the link: ${String(q)}`)
  const result = checkFilter(q, LOG_FIELDS)
  if (!result.ok) throw new Error(result.error.message)
  return result.query.terms.map((term) => [term.key, term.value])
}

describe('linkToLogs', () => {
  it('writes only canonical keys of the Logs filter', () => {
    const keys = new Set(cases.fields.map((field) => field.key))
    for (const key of LOGS_LINK_KEYS) expect(keys.has(key), key).toBe(true)
  })

  it('writes q with the canonical keys, in order, and passes the rest as params', () => {
    const link = linkToLogs({
      level: 'error',
      service: 'functions',
      instance: 'resize-images',
      execution: 'a3f9c1-1284',
      function: 'us-central1-hello',
      from: '-5m',
      to: '2026-10-12T04:10:00Z',
      entry: '9f3c0a71.18204',
      since: '9f3c0a71.18000',
    })
    expect(link).toEqual({
      to: '/logs',
      search: {
        q: 'function:us-central1-hello execution:a3f9c1-1284 instance:resize-images service:functions level:error',
        from: '-5m',
        to: '2026-10-12T04:10:00Z',
        entry: '9f3c0a71.18204',
        since: '9f3c0a71.18000',
      },
    })
    expect(terms(link.search?.q)).toEqual([
      ['function', 'us-central1-hello'],
      ['execution', 'a3f9c1-1284'],
      ['instance', 'resize-images'],
      ['service', 'functions'],
      ['level', 'error'],
    ])
  })

  it('quotes every value the grammar would read otherwise, so it parses back to itself', () => {
    const awkward = ['my instance', 'say "hi"', 'back\\slash', '>later', '<x', '=y', 'tab\there']
    for (const value of awkward) {
      const link = linkToLogs({ instance: value })
      expect(terms(link.search?.q), value).toEqual([['instance', value]])
    }
  })

  it('merges nothing else, and leaves out empty fields', () => {
    expect(linkToLogs({})).toEqual({ to: '/logs' })
    expect(linkToLogs({ function: '', entry: 'c1' })).toEqual({
      to: '/logs',
      search: { entry: 'c1' },
    })
    const extra = { function: 'f', fn: 'x', exec: 'y' } as Parameters<typeof linkToLogs>[0]
    expect(linkToLogs(extra)).toEqual({ to: '/logs', search: { q: 'function:f' } })
  })
})

describe('the Logs registry entry', () => {
  it('opens a line by its cursor', () => {
    expect(logs.routes?.['logs.entry']?.('9f3c0a71.18204')).toEqual({
      to: '/logs',
      search: { entry: '9f3c0a71.18204' },
    })
  })

  it('leads its badge to the errors, after the newest one already seen', () => {
    expect(logs.badges).toEqual(['logs.errors'])
    expect(logs.badgeLink?.({ count: 4, cursor: '9f3c0a71.18000' })).toEqual({
      to: '/logs',
      search: { q: 'level:error', since: '9f3c0a71.18000' },
    })
    expect(logs.badgeLink?.({ count: 4 })).toEqual({ to: '/logs', search: { q: 'level:error' } })
  })

  it('searches for text as words, or as one phrase when it would read as a filter', () => {
    const search = logs.searchLink
    if (typeof search !== 'function') throw new Error('Logs has a search link')
    expect(search('cart empty')).toEqual({ to: '/logs', search: { q: 'cart empty' } })
    expect(search('TypeError: x is undefined')).toEqual({
      to: '/logs',
      search: { q: '"TypeError: x is undefined"' },
    })
    expect(search('/api/users')).toEqual({ to: '/logs', search: { q: '"/api/users"' } })
    expect(search('-x')).toEqual({ to: '/logs', search: { q: '"-x"' } })
    expect(search('  ')).toEqual({ to: '/logs' })
    for (const text of ['TypeError: x', '/api/users', 'say "hi"', 'level=error', 'a b'])
      expect(checkFilter(String(search(text).search?.q), LOG_FIELDS).ok, text).toBe(true)
  })

  it('offers the Overview’s suite-wide actions as links, registered only here', () => {
    const links = Object.fromEntries((logs.actions ?? []).map((action) => [action.id, action.link]))
    expect(links).toEqual({
      'logs.errors': { to: '/logs', search: { q: 'level:error' } },
      'logs.problems': { to: '/logs', search: { q: 'is:problem' } },
      'overview.snapshot': { to: '/', search: { dialog: 'snapshot' } },
      'overview.reset': { to: '/', search: { dialog: 'reset' } },
      'overview.env': { to: '/', search: { connect: 'env' } },
    })
  })

  it('is built: its journeys pass against a real engine (e2e/logs.spec.ts)', () => {
    expect(logs.built).toBe(true)
    expect(logs.pages).toBeUndefined()
    expect(logs.projectScope).toBeUndefined()
  })
})
