import { describe, expect, it } from 'vitest'
import type { Badge } from '@/api/generated/live/Badge'
import { sectionEntry, testStatus } from '@/test/status'
import {
  addressOf,
  dataWords,
  figureText,
  holdsNothing,
  infrastructure,
  logsEntryLink,
  logsProblemsLink,
  noticeParts,
  linkedReset,
  problemLink,
  resetConsequence,
  resettableSections,
  sectionCards,
  sharedHost,
  shortPath,
  suiteHealth,
  tileAddress,
  uptime,
} from './model'

const service = (name: string, port: number, host = '127.0.0.1') => ({
  name,
  host,
  port,
  listening: true,
  pid: null,
})

const gauge = (id: string, count: number, overrides: Partial<Badge> = {}): Badge => ({
  id,
  count,
  kind: 'gauge',
  tone: 'danger',
  noun: { one: 'rules file does not compile', other: 'rules files do not compile' },
  ...overrides,
})

const badges = (...list: Badge[]) => new Map(list.map((badge) => [badge.id, badge]))

const STATUS = testStatus({
  services: [
    service('firestore', 8080),
    service('functions', 5001),
    service('hub', 4400),
    service('ui', 4000),
    service('logging', 4500),
    service('firestore.websocket', 9150),
  ],
  sections: [
    sectionEntry('firestore', {
      summary: {
        headline: '211,260 documents · 3 databases',
        figures: [
          { label: 'Documents', value: 211_260, unit: 'count' },
          { label: 'Databases', value: 3, unit: 'count' },
        ],
      },
    }),
    sectionEntry('auth', {
      state: 'absent',
      reason: 'excluded-by-only',
      detail: 'This engine was started without Authentication.',
      fixes: [{ label: 'Start with it', kind: 'command', text: 'firenook emulators:start' }],
    }),
    sectionEntry('storage', { state: 'absent', reason: 'not-configured' }),
    sectionEntry('functions', {
      state: 'starting',
      detail: 'Discovering functions in 2 codebases…',
    }),
    sectionEntry('extensions'),
    sectionEntry('logs'),
  ],
})

describe('section tiles', () => {
  it('are drawn for every section, absent ones in their place, in the sidebar order', () => {
    const cards = sectionCards(STATUS, badges())
    expect(cards.map((card) => [card.section.id, card.health.label])).toEqual([
      ['firestore', 'Running'],
      ['auth', 'Not running'],
      ['storage', 'Not running'],
      ['functions', 'Starting'],
      ['extensions', 'Running'],
      ['logs', 'Running'],
    ])
    expect(cards[0]?.address && addressOf(cards[0].address)).toBe('127.0.0.1:8080')
    expect(cards[5]?.address && addressOf(cards[5].address)).toBe('127.0.0.1:4500')
    // A section the engine does not run has no address to show.
    expect(cards[1]?.address).toBeUndefined()
  })

  it('say when a tile shows an address another one already does', () => {
    const cards = sectionCards(STATUS, badges())
    expect(cards[3]?.sharedWith).toBeUndefined()
    expect(cards[4]?.sharedWith?.id).toBe('functions')
  })

  it('count only the section’s gauges above zero that are not neutral as its problems', () => {
    const cards = sectionCards(
      STATUS,
      badges(
        gauge('firestore.rules', 1),
        gauge('firestore.denials', 7, { kind: 'counter', tone: 'neutral' }),
        gauge('firestore.jobs', 1, { tone: 'neutral' }),
        gauge('logs.errors', 3, { kind: 'counter', tone: 'attention' }),
      ),
    )
    const firestore = cards[0]
    expect(firestore?.problems).toEqual([
      // The gauge links to the page that carries it.
      {
        id: 'firestore.rules',
        text: '1 rules file does not compile',
        link: { to: '/firestore/rules' },
      },
    ])
    expect(firestore?.health).toEqual({ tone: 'warning', label: '1 problem', pulse: false })
    expect(cards[5]?.problems).toEqual([])
  })

  it('link a gauge no page carries to the section itself', () => {
    const cards = sectionCards(
      testStatus({ sections: [sectionEntry('functions')] }),
      badges(
        gauge('functions.load', 2, {
          noun: { one: 'codebase failed to load', other: 'codebases failed to load' },
        }),
      ),
    )
    expect(cards[0]?.problems).toEqual([
      { id: 'functions.load', text: '2 codebases failed to load', link: { to: '/functions' } },
    ])
    expect(cards[0]?.health.label).toBe('1 problem')
  })

  it('show a starting section as starting, with no problems and the engine’s detail', () => {
    const functions = sectionCards(STATUS, badges(gauge('functions.load', 1)))[3]
    expect(functions?.health).toEqual({ tone: 'neutral', label: 'Starting', pulse: true })
    expect(functions?.problems).toEqual([])
    expect(functions?.status.detail).toBe('Discovering functions in 2 codebases…')
  })

  it('show the port alone when the host is the one every tile shares', () => {
    const cards = sectionCards(STATUS, badges())
    expect(sharedHost(cards)).toBe('127.0.0.1')
    const firestore = service('firestore', 8080)
    expect(tileAddress(firestore, '127.0.0.1')).toBe(':8080')
    expect(tileAddress(firestore, undefined)).toBe('127.0.0.1:8080')
    const split = sectionCards(
      testStatus({
        services: [service('firestore', 8080), service('functions', 5001, '::1')],
        sections: [sectionEntry('firestore'), sectionEntry('functions')],
      }),
      badges(),
    )
    expect(sharedHost(split)).toBeUndefined()
    expect(tileAddress(service('functions', 5001, '::1'), undefined)).toBe('[::1]:5001')
  })
})

describe('the suite in one line', () => {
  const tiles = (...sections: Parameters<typeof sectionEntry>[]) =>
    sectionCards(testStatus({ sections: sections.map((args) => sectionEntry(...args)) }), badges())

  it('says every service runs only when none is missing', () => {
    expect(suiteHealth(tiles(['firestore'], ['auth']))).toEqual({
      tone: 'success',
      label: 'All 2 services running',
      pulse: false,
    })
    expect(suiteHealth(tiles(['firestore'], ['auth', { state: 'absent' }])).label).toBe(
      '1 service running',
    )
  })

  it('says what starts, and then what needs attention', () => {
    expect(suiteHealth(tiles(['firestore'], ['functions', { state: 'starting' }]))).toEqual({
      tone: 'neutral',
      label: '1 running, 1 starting',
      pulse: true,
    })
    const troubled = sectionCards(
      testStatus({ sections: [sectionEntry('firestore'), sectionEntry('auth')] }),
      badges(gauge('firestore.rules', 1)),
    )
    expect(suiteHealth(troubled)).toEqual({
      tone: 'warning',
      label: '2 running · 1 service needs attention',
      pulse: false,
    })
  })

  it('says nothing runs when nothing does', () => {
    expect(suiteHealth(tiles(['firestore', { state: 'absent' }])).label).toBe('No services running')
  })
})

describe('figures', () => {
  it('are grouped, sized when they are bytes, and a dash while still being counted', () => {
    expect(figureText({ label: 'Documents', value: 211_260, unit: 'count' })).toBe('211,260')
    expect(figureText({ label: 'Bytes', value: 1_288_490_189, unit: 'bytes' })).toBe('1.2 GB')
    expect(figureText({ label: 'Buckets', value: null, unit: 'count' })).toBe('—')
  })

  it('say a section holds nothing only when its first figure is zero', () => {
    expect(holdsNothing(null)).toBe(false)
    expect(
      holdsNothing({ headline: '0 documents', figures: [{ label: 'D', value: 0, unit: 'count' }] }),
    ).toBe(true)
    expect(
      holdsNothing({ headline: '…', figures: [{ label: 'D', value: null, unit: 'count' }] }),
    ).toBe(false)
  })
})

describe('the engine card', () => {
  it('lists the hub, this UI, the logging feed and the requests socket that the engine runs', () => {
    expect(
      infrastructure(STATUS).map((entry) => [entry.label, entry.address, entry.thisPage]),
    ).toEqual([
      ['Hub', '127.0.0.1:4400', false],
      ['Console', '127.0.0.1:4000', true],
      ['Logging feed', '127.0.0.1:4500', false],
      ['Firestore requests', '127.0.0.1:9150', false],
    ])
    expect(addressOf({ host: '::1', port: 4000 })).toBe('[::1]:4000')
  })

  it('takes the middle out of a long path, keeping the folders that name it', () => {
    expect(shortPath('/work/clients/acme/shop/apps/web-firebase')).toBe(
      '/work/…/shop/apps/web-firebase',
    )
    expect(shortPath('/work/shop/firebase.json')).toBe('/work/shop/firebase.json')
    expect(shortPath('C:\\Users\\dev\\work\\shop\\apps\\web')).toBe('C:\\…\\shop\\apps\\web')
    expect(shortPath('relative/a/b/c/d')).toBe('relative/a/b/c/d')
    expect(shortPath('relative/a/b/c/d/e')).toBe('relative/…/c/d/e')
  })
})

describe('resets', () => {
  it('are offered for ready sections the console can clear', () => {
    const status = testStatus({
      sections: [
        sectionEntry('firestore'),
        sectionEntry('auth'),
        sectionEntry('functions'),
        sectionEntry('logs'),
      ],
    })
    // Functions and Logs keep no data to reset.
    expect(resettableSections(status).map((entry) => entry.section.id)).toEqual([
      'firestore',
      'auth',
    ])
    expect(
      resettableSections(
        testStatus({ sections: [sectionEntry('firestore', { state: 'starting' })] }),
      ),
    ).toEqual([])
  })

  it('open the reset a link names, and never another section’s', () => {
    const two = [{ section: { id: 'firestore' as const } }, { section: { id: 'auth' as const } }]
    expect(linkedReset(two, 'auth')).toEqual({ kind: 'section', id: 'auth' })
    expect(linkedReset(two, 'storage')).toBeUndefined()
    expect(linkedReset(two, undefined)).toEqual({ kind: 'everything' })
    expect(linkedReset(two.slice(1), undefined)).toEqual({ kind: 'section', id: 'auth' })
    expect(linkedReset([], undefined)).toBeUndefined()
  })

  it('carry each section’s own consequence line', () => {
    expect(resetConsequence('auth')).toBe('Codes and links already issued stay in the inbox.')
    expect(resetConsequence('tasks')).toBe('Queues stay; their tasks are deleted.')
    expect(resetConsequence('firestore')).toBeUndefined()
    expect(resetConsequence('logs')).toBeUndefined()
  })
})

describe('the header', () => {
  it('says how long the engine has run, to the minute', () => {
    const start = '2026-10-12T10:00:00.000Z'
    const at = (ms: number) => Date.parse(start) + ms
    expect(uptime(start, at(20_000))).toBe('under a minute')
    expect(uptime(start, at(14 * 60_000 + 59_000))).toBe('14 min')
    expect(uptime(start, at(134 * 60_000 + 30_000))).toBe('2 h 14 min')
    expect(uptime('not a time', at(0))).toBe('—')
  })

  it('words where the data lives', () => {
    const data = STATUS.data
    expect(dataWords(data)).toBe('in memory')
    expect(dataWords({ ...data, mode: 'disk', resumed: true })).toBe('on disk, resumed')
    expect(dataWords({ ...data, mode: 'disk', importedFrom: '/seed' })).toBe(
      'on disk, imported at start',
    )
  })
})

describe('notices', () => {
  it('take the first sentence as the title and the rest as the description', () => {
    expect(
      noticeParts(
        'Project ID "shop-dev" is not a demo project. The emulators never contact Firebase, but code can.',
      ),
    ).toEqual({
      title: 'Project ID "shop-dev" is not a demo project.',
      description: 'The emulators never contact Firebase, but code can.',
    })
    expect(
      noticeParts('Diagnostics are off (--no-diagnostics), so the rules pages show nothing.'),
    ).toEqual({
      title: 'Diagnostics are off (--no-diagnostics), so the rules pages show nothing.',
      description: undefined,
    })
  })
})

describe('recent problems', () => {
  const status = testStatus({ sections: [sectionEntry('firestore'), sectionEntry('logs')] })

  it('end with "See why" for a refused rules decision', () => {
    const link = problemLink(
      {
        refs: [
          { kind: 'firestore.document', key: '(default)|users/u_1' },
          { kind: 'firestore.decision', key: '(default)|req-1' },
        ],
      },
      status,
    )
    expect(link).toEqual({
      link: {
        to: '/firestore/rules',
        search: { db: undefined, panel: 'decisions', decision: 'req-1' },
      },
      label: 'See why',
      kind: 'firestore.decision',
      key: '(default)|req-1',
    })
  })

  it('else with the first thing they name that opens in its section, and nothing otherwise', () => {
    const refs = [
      { kind: 'functions.function', key: 'us-central1-fails' },
      { kind: 'firestore.document', key: '(default)|carts/c_1', label: 'carts/c_1' },
    ]
    expect(problemLink({ refs }, status)).toMatchObject({
      label: 'us-central1-fails',
      kind: 'functions.function',
    })
    const noFunctions = testStatus({
      sections: [
        sectionEntry('firestore'),
        sectionEntry('logs'),
        sectionEntry('functions', { state: 'absent' }),
      ],
    })
    expect(problemLink({ refs }, noFunctions)).toMatchObject({
      label: 'carts/c_1',
      kind: 'firestore.document',
    })
    expect(
      problemLink({ refs: [{ kind: 'functions.function', key: 'us-central1-x' }] }, noFunctions),
    ).toBeUndefined()
    expect(problemLink({ refs: [] }, status)).toBeUndefined()
  })

  it('open their line in Logs, and every problem, while Logs runs', () => {
    expect(logsEntryLink('ab.1', status)).toEqual({ to: '/logs', search: { entry: 'ab.1' } })
    expect(logsProblemsLink(status)).toEqual({ to: '/logs', search: { q: 'is:problem' } })
    const absent = testStatus({
      sections: [sectionEntry('firestore'), sectionEntry('logs', { state: 'absent' })],
    })
    expect(logsEntryLink('ab.1', absent)).toBeNull()
    expect(logsProblemsLink(absent)).toBeNull()
  })
})
