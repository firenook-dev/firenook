import { describe, expect, it, vi } from 'vitest'
import type { PaletteGroup, PaletteItem } from '@/lib/palette'
import type { SectionLink } from '@/lib/services'
import { sectionEntry, testStatus } from '@/test/status'
import { engineGroups, mergeGroups } from './command-palette'

// Storage stands in for a built section whose `q` is a text filter, so the
// "Search <section> for" row has a section to belong to.
vi.mock('@/lib/services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services')>()
  const base = actual.sectionById('storage')
  if (!base) throw new Error('the registry has no storage section')
  const storage = {
    ...base,
    built: true,
    searchLabels: { 'storage.object': 'Objects' },
    routes: { 'storage.object': (key: string) => ({ to: '/storage', search: { object: key } }) },
  }
  return {
    ...actual,
    sectionById: (id: string) => (id === 'storage' ? storage : actual.sectionById(id)),
  }
})

const opened: SectionLink[] = []
const go = (link: SectionLink) => () => {
  opened.push(link)
}

describe('what ⌘K shows of the engine’s search', () => {
  const status = testStatus({ sections: [sectionEntry('firestore')] })

  it('one group per kind, labelled by the section, each hit opening through its registry', () => {
    const groups = engineGroups(
      {
        partial: false,
        groups: [
          {
            section: 'firestore',
            hits: [
              {
                kind: 'firestore.collection',
                key: '(default)|products',
                title: 'products',
                detail: '12 documents',
              },
              {
                kind: 'firestore.document',
                key: '(default)|products/p1',
                title: 'products/p1',
                detail: null,
              },
            ],
          },
        ],
      },
      'prod',
      status,
      go,
    )
    expect(groups.map((group) => group.label)).toEqual(['Collections', 'Documents'])
    expect(groups[0]?.items[0]).toMatchObject({ title: 'products', description: '12 documents' })
    groups[1]?.items[0]?.run()
    expect(opened.at(-1)).toEqual({
      to: '/firestore',
      search: { db: undefined, path: 'products', doc: 'products/p1' },
    })
    // Firestore's `q` is not a text filter: no "Search Firestore for" row.
    expect(
      groups.flatMap((group) => group.items).some((item) => item.id.startsWith('search:')),
    ).toBe(false)
  })

  it('drops hits of a section that is not built, or that the engine does not run', () => {
    const results = {
      partial: false,
      groups: [
        {
          section: 'auth',
          hits: [{ kind: 'auth.user', key: '|u1', title: 'ada@example.test', detail: null }],
        },
        {
          section: 'firestore',
          hits: [
            { kind: 'firestore.collection', key: '(default)|users', title: 'users', detail: null },
          ],
        },
      ],
    }
    expect(engineGroups(results, 'ada', status, go).map((group) => group.label)).toEqual([
      'Collections',
    ])
    const absent = testStatus({ sections: [sectionEntry('firestore', { state: 'absent' })] })
    expect(engineGroups(results, 'ada', absent, go)).toEqual([])
  })

  it('shows nothing before the engine answered, or when it has no search', () => {
    expect(engineGroups(undefined, 'prod', status, go)).toEqual([])
    expect(engineGroups(null, 'prod', status, go)).toEqual([])
  })
})

const row = (title: string): PaletteItem => ({ id: title, title, icon: null, run: () => {} })

describe('one row per thing in ⌘K', () => {
  const status = testStatus({ sections: [sectionEntry('firestore'), sectionEntry('storage')] })
  const results = {
    partial: false,
    groups: [
      {
        section: 'firestore',
        hits: [
          {
            kind: 'firestore.collection',
            key: '(default)|products',
            title: 'products',
            detail: null,
          },
          {
            kind: 'firestore.document',
            key: '(default)|products/p1',
            title: 'products/p1',
            detail: 'Document · 3 fields',
          },
        ],
      },
      {
        section: 'storage',
        hits: [{ kind: 'storage.object', key: 'b|cat.png', title: 'cat.png', detail: null }],
      },
    ],
  }

  it('leaves out the hits the page on screen already offers, and keeps the search row', () => {
    const offered = new Set(['firestore.collection (default)|products', 'storage.object b|cat.png'])
    const groups = engineGroups(results, 'prod', status, go, offered)
    expect(groups.map((group) => [group.label, group.items.map((item) => item.title)])).toEqual([
      ['Documents', ['products/p1']],
      ['Storage', ['Search Storage for “prod”']],
    ])
    // With nothing offered, the row closes the section's last group.
    expect(
      engineGroups(results, 'prod', status, go)
        .at(-1)
        ?.items.map((item) => item.title),
    ).toEqual(['cat.png', 'Search Storage for “prod”'])
  })

  it('merges groups that share a label, in the order labels first appear', () => {
    const groups: PaletteGroup[] = [
      { label: 'Collections', items: [row('users')] },
      { label: 'Documents', items: [row('users/u1')] },
      { label: 'Collections', items: [row('orders')] },
      { label: 'Layout', items: [] },
    ]
    expect(
      mergeGroups(groups).map((group) => [group.label, group.items.map((i) => i.title)]),
    ).toEqual([
      ['Collections', ['users', 'orders']],
      ['Documents', ['users/u1']],
    ])
    // The groups passed in are left as they were.
    expect(groups[0]?.items.map((i) => i.title)).toEqual(['users'])
  })
})
