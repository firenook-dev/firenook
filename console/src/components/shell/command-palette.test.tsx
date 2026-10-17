import { describe, expect, it, vi } from 'vitest'
import type { PaletteGroup, PaletteItem } from '@/lib/palette'
import type { SectionLink } from '@/lib/services'
import { sectionEntry, testStatus } from '@/test/status'
import { engineGroups, mergeGroups, suiteItems } from './command-palette'

// Storage stands in for a section whose `q` is a text filter, so the
// "Search <section> for" row has a section to belong to.
vi.mock('@/lib/services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services')>()
  const base = actual.sectionById('storage')
  if (!base) throw new Error('the registry has no storage section')
  const storage = {
    ...base,
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

  it('drops hits of a section the engine does not run', () => {
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
    const noAuth = testStatus({
      sections: [sectionEntry('firestore'), sectionEntry('auth', { state: 'absent' })],
    })
    expect(engineGroups(results, 'ada', noAuth, go).map((group) => group.label)).toEqual([
      'Collections',
    ])
    const neither = testStatus({
      sections: [
        sectionEntry('firestore', { state: 'absent' }),
        sectionEntry('auth', { state: 'absent' }),
      ],
    })
    expect(engineGroups(results, 'ada', neither, go)).toEqual([])
  })

  it('labels a hit by the section it opens in, whichever source found it', () => {
    // Compute's search answers for Functions and for Extensions instances.
    const running = testStatus({
      sections: [sectionEntry('functions'), sectionEntry('extensions')],
    })
    const groups = engineGroups(
      {
        partial: false,
        groups: [
          {
            section: 'functions',
            hits: [
              {
                kind: 'extensions.instance',
                key: 'greeter',
                title: 'Greeter',
                detail: 'Extension · ./extensions/greeter',
              },
              {
                kind: 'functions.function',
                key: 'us-central1-ext-greeter-greet',
                title: 'ext-greeter-greet',
                detail: null,
              },
            ],
          },
        ],
      },
      'greeter',
      running,
      go,
    )
    expect(groups.map((group) => group.label)).toEqual(['Extensions', 'Functions'])
    groups[0]?.items[0]?.run()
    expect(opened.at(-1)).toEqual({ to: '/extensions', search: { instance: 'greeter' } })
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

/** A running service, as the status lists it. */
const service = (name: string) => ({
  name,
  host: '127.0.0.1',
  port: 1,
  listening: true,
  pid: null,
})

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id)

describe('⌘K’s Suite group', () => {
  const actions = () => ({
    go: (link: SectionLink) => () => {
      opened.push(link)
    },
    connect: vi.fn(),
    openPart: vi.fn(),
    download: vi.fn(),
    setBackground: vi.fn(),
  })
  it('offers each suite action once, from any page, and each opens where it lives', () => {
    const status = testStatus({
      services: ['firestore', 'auth', 'functions'].map(service),
      sections: [sectionEntry('firestore'), sectionEntry('auth'), sectionEntry('functions')],
    })
    const wired = actions()
    const items = suiteItems(status, wired)
    expect(ids(items)).toEqual([
      'suite:background',
      'suite:snapshot',
      'suite:save',
      'suite:reset',
      'suite:connect',
      'suite:env',
      'suite:engine',
    ])
    const run = (id: string) => items.find((item) => item.id === id)?.run()
    run('suite:snapshot')
    expect(wired.download).toHaveBeenCalledOnce()
    run('suite:save')
    expect(opened.at(-1)).toEqual({ to: '/', search: { dialog: 'save' } })
    run('suite:reset')
    expect(opened.at(-1)).toEqual({ to: '/', search: { dialog: 'reset' } })
    run('suite:connect')
    expect(wired.connect).toHaveBeenLastCalledWith()
    run('suite:env')
    expect(wired.connect).toHaveBeenLastCalledWith('env')
    run('suite:engine')
    expect(wired.openPart).toHaveBeenCalledWith('engine')
    run('suite:background')
    expect(wired.setBackground).toHaveBeenCalledWith(false)
  })

  it('leaves out what the engine has nothing for', () => {
    // Pub/Sub alone: nothing a snapshot holds, a reset still; no triggers to pause.
    const pubsub = testStatus({
      services: [service('pubsub')],
      sections: [sectionEntry('pubsub')],
    })
    expect(ids(suiteItems(pubsub, actions()))).toEqual([
      'suite:reset',
      'suite:connect',
      'suite:env',
      'suite:engine',
    ])
    // Logs alone: nothing to snapshot or reset.
    const logs = testStatus({ services: [service('logging')], sections: [sectionEntry('logs')] })
    expect(ids(suiteItems(logs, actions()))).toEqual(['suite:connect', 'suite:env', 'suite:engine'])
  })
})
