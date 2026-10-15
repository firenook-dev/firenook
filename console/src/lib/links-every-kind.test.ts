// Every kind of link the engine writes leads to a real page that accepts it.
// The engine pins one sample reference of each kind it constructs
// (crates/suite-front/src/entity.rs writes entity-kinds.json and fails when a
// constructor has no sample); here each one is resolved through its section's
// registry, as a log line or a trigger chip resolves it, and the page it names
// must exist in the route tree and take the search the link carries — as the
// router reads it from the address, so a link opened in a new tab works too.
// Every action ⌘K offers from anywhere is held to the same.

import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, defaultStringifySearch } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import type { EntityRef } from '@/api/generated/EntityRef'
import { routeTree } from '@/routeTree.gen'
import { sectionEntry, testStatus } from '@/test/status'
import kinds from './entity-kinds.json'
import { linkTo } from './links'
import { SECTION_ACTIONS } from './palette-actions'
import { parseSearch } from './search-params'
import { SECTIONS } from './services'

const everySectionReady = testStatus({
  sections: SECTIONS.map((section) => sectionEntry(section.id)),
})

const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ['/'] }),
  context: { queryClient: new QueryClient() },
  parseSearch,
})

/** The page's own reading of the search an address carries. */
function validated(to: string, search: Record<string, unknown> | undefined): unknown {
  const route = (
    router.routesByPath as unknown as Record<string, { options: { validateSearch?: unknown } }>
  )[to]
  if (!route) throw new Error(`no page at ${to}`)
  const read = parseSearch(defaultStringifySearch(search ?? {}))
  const schema = route.options.validateSearch as
    | { parse: (value: unknown) => unknown }
    | ((value: unknown) => unknown)
    | undefined
  if (schema === undefined) return read
  return typeof schema === 'function' ? schema(read) : schema.parse(read)
}

describe('every kind of link', () => {
  it('has a sample from the engine, one per kind', () => {
    const seen = new Set((kinds as EntityRef[]).map((entity) => entity.kind))
    expect(seen.size).toBe(kinds.length)
    expect(seen.size).toBeGreaterThan(20)
  })

  for (const entity of kinds as EntityRef[])
    it(`${entity.kind} opens a real page that takes its search`, () => {
      const link = linkTo(entity, everySectionReady)
      expect(link, `${entity.kind} resolves`).not.toBeNull()
      if (!link) return
      // The page exists, and the section that owns the kind is the one it opens.
      expect(Object.keys(router.routesByPath)).toContain(link.to)
      expect(link.to.split('/')[1]).toBe(entity.kind.slice(0, entity.kind.indexOf('.')))
      // Nothing the link says is dropped: every param reaches the page (an
      // id the page reads as a number may arrive as one).
      const search = validated(link.to, link.search) as Record<string, unknown>
      for (const [key, value] of Object.entries(link.search ?? {}))
        if (value !== undefined)
          expect(String(search[key]), `${entity.kind} ${key}`).toBe(String(value))
    })
})

describe('every ⌘K action', () => {
  const actions = Object.values(SECTION_ACTIONS).flat()

  it('has an id of its own', () => {
    expect(actions.length).toBeGreaterThan(10)
    expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length)
  })

  for (const action of actions)
    it(`${action.id} opens a real page that takes its search`, () => {
      expect(Object.keys(router.routesByPath)).toContain(action.link.to)
      const search = validated(action.link.to, action.link.search) as Record<string, unknown>
      for (const [key, value] of Object.entries(action.link.search ?? {}))
        if (value !== undefined)
          expect(String(search[key]), `${action.id} ${key}`).toBe(String(value))
    })
})
