import { describe, expect, it } from 'vitest'
import type { SectionLink } from '@/lib/services'
import { sectionEntry, testStatus } from '@/test/status'
import { engineGroups } from './command-palette'

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
