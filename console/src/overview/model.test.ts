import { describe, expect, it } from 'vitest'
import type { Badge } from '@/api/generated/live/Badge'
import { auth } from '@/lib/sections/auth'
import { functions as functionsSection } from '@/lib/sections/functions'
import { sectionEntry, testStatus } from '@/test/status'
import { whileUnbuilt } from '@/test/unbuilt'
import {
  absentGroups,
  absentSections,
  addressOf,
  cardConnect,
  dataWords,
  engineName,
  figureText,
  holdsNothing,
  infrastructure,
  logsEntryLink,
  logsProblemsLink,
  noticeParts,
  problemLink,
  resetConsequence,
  resettableSections,
  sectionCards,
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

describe('section cards', () => {
  it('are drawn for every section that runs or starts, in the sidebar order, with its address', () => {
    const cards = sectionCards(STATUS, badges())
    expect(cards.map((card) => card.section.id)).toEqual([
      'firestore',
      'functions',
      'extensions',
      'logs',
    ])
    expect(cards[0]?.address && addressOf(cards[0].address)).toBe('127.0.0.1:8080')
    expect(cards[3]?.address && addressOf(cards[3].address)).toBe('127.0.0.1:4500')
  })

  it('say when a card shows an address another one already does', () => {
    const [, functions, extensions] = sectionCards(STATUS, badges())
    expect(functions?.sharedWith).toBeUndefined()
    expect(extensions?.sharedWith?.id).toBe('functions')
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
      // Firestore is built: the gauge links to the page that carries it.
      {
        id: 'firestore.rules',
        text: '1 rules file does not compile',
        link: { to: '/firestore/rules' },
      },
    ])
    expect(firestore?.health).toEqual({ tone: 'warning', label: '1 problem', pulse: false })
    expect(cards[3]?.problems).toEqual([])
  })

  it('never link a problem into a section that is not built', async () => {
    const cards = await whileUnbuilt(functionsSection, () =>
      sectionCards(
        testStatus({ sections: [sectionEntry('functions')] }),
        badges(
          gauge('functions.load', 2, {
            noun: { one: 'codebase failed to load', other: 'codebases failed to load' },
          }),
        ),
      ),
    )
    expect(cards[0]?.problems).toEqual([
      { id: 'functions.load', text: '2 codebases failed to load', link: null },
    ])
    expect(cards[0]?.health.label).toBe('1 problem')
  })

  it('show a starting section as starting, with no problems and the engine’s detail', () => {
    const functions = sectionCards(STATUS, badges(gauge('functions.load', 1)))[1]
    expect(functions?.health).toEqual({ tone: 'neutral', label: 'Starting', pulse: true })
    expect(functions?.problems).toEqual([])
    expect(functions?.status.detail).toBe('Discovering functions in 2 codebases…')
  })

  it('send the Functions card to its lines in Logs while Logs runs, and no other card', () => {
    const cards = sectionCards(STATUS, badges())
    expect(cards.find((card) => card.section.id === 'functions')?.logs).toEqual({
      to: '/logs',
      search: { q: 'service:functions' },
    })
    for (const card of cards.filter((entry) => entry.section.id !== 'functions'))
      expect(card.logs).toBeNull()
    const absent = testStatus({
      sections: [sectionEntry('functions'), sectionEntry('logs', { state: 'absent' })],
    })
    expect(sectionCards(absent, badges())[0]?.logs).toBeNull()
  })

  it('link a built section’s later pages, and none of an unbuilt one', async () => {
    const cards = sectionCards(STATUS, badges())
    expect(cards[0]?.pages).toEqual([
      expect.objectContaining({ to: '/firestore/rules', label: 'Rules' }),
    ])
    expect(cards[1]?.pages).toEqual([
      expect.objectContaining({ to: '/functions/invocations', label: 'Invocations' }),
    ])
    const unbuilt = await whileUnbuilt(functionsSection, () => sectionCards(STATUS, badges()))
    expect(unbuilt[1]?.pages).toEqual([])
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

describe('infrastructure and absent sections', () => {
  it('list the hub, this UI, the logging feed and the requests socket that the engine runs', () => {
    expect(
      infrastructure(STATUS).map((entry) => [entry.label, entry.address, entry.thisPage]),
    ).toEqual([
      ['Hub', '127.0.0.1:4400', false],
      ['Emulator UI', '127.0.0.1:4000', true],
      ['Logging feed', '127.0.0.1:4500', false],
      ['Firestore requests', '127.0.0.1:9150', false],
    ])
    expect(addressOf({ host: '::1', port: 4000 })).toBe('[::1]:4000')
  })

  it('give every absent section the engine’s sentence, or a plain one', () => {
    expect(
      absentSections(STATUS).map((entry) => [
        entry.section.id,
        entry.detail,
        entry.status.fixes.length,
      ]),
    ).toEqual([
      ['auth', 'This engine was started without Authentication.', 1],
      ['storage', 'This engine does not run Storage.', 0],
    ])
  })
})

describe('absent sections that one fix turns on', () => {
  it('share it, printed once, in the order each group first appears', () => {
    const functions = {
      label: 'Add it to firebase.json',
      kind: 'firebase-json' as const,
      text: '"functions": [{ "source": "functions" }]',
    }
    const status = testStatus({
      sections: [
        sectionEntry('storage', {
          state: 'absent',
          fixes: [
            { label: 'Add it to firebase.json', kind: 'firebase-json', text: '"storage": {}' },
          ],
        }),
        sectionEntry('functions', { state: 'absent', fixes: [functions] }),
        sectionEntry('extensions', { state: 'absent', fixes: [functions] }),
        sectionEntry('pubsub', { state: 'absent' }),
        sectionEntry('eventarc', { state: 'absent', fixes: [functions] }),
        sectionEntry('tasks', { state: 'absent' }),
      ],
    })
    expect(
      absentGroups(status).map((group) => [
        group.sections.map((entry) => entry.section.id),
        group.fixes.length,
      ]),
    ).toEqual([
      [['storage'], 1],
      [['functions', 'extensions', 'eventarc'], 1],
      [['pubsub'], 0],
      [['tasks'], 0],
    ])
  })
})

describe('resets', () => {
  it('are offered for built, ready sections the console can clear', async () => {
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
    // A section's reset lands with its pages: an unbuilt one is not offered.
    expect(
      await whileUnbuilt(auth, () => resettableSections(status).map((entry) => entry.section.id)),
    ).toEqual(['firestore'])
    expect(
      resettableSections(
        testStatus({ sections: [sectionEntry('firestore', { state: 'starting' })] }),
      ),
    ).toEqual([])
  })

  it('carry each section’s own consequence line', () => {
    expect(resetConsequence('auth')).toBe('Codes and links already issued stay in the inbox.')
    expect(resetConsequence('tasks')).toBe('Queues stay; their tasks are deleted.')
    expect(resetConsequence('firestore')).toBeUndefined()
    expect(resetConsequence('logs')).toBeUndefined()
  })
})

describe('the header', () => {
  it('names the engine’s release, or says it has none', () => {
    const engine = { name: 'Firenook', version: '0.2.0-next.3', revision: null, consoleBuild: 'x' }
    expect(engineName(engine)).toBe('Firenook 0.2.0-next.3')
    expect(engineName({ ...engine, version: null })).toBe('Firenook, unreleased build')
  })

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

  it('else with the first thing they name that opens in its section, and nothing otherwise', async () => {
    const refs = [
      { kind: 'functions.function', key: 'us-central1-fails' },
      { kind: 'firestore.document', key: '(default)|carts/c_1', label: 'carts/c_1' },
    ]
    expect(problemLink({ refs }, status)).toMatchObject({
      label: 'us-central1-fails',
      kind: 'functions.function',
    })
    await whileUnbuilt(functionsSection, () => {
      expect(problemLink({ refs }, status)).toMatchObject({
        label: 'carts/c_1',
        kind: 'firestore.document',
      })
      expect(
        problemLink({ refs: [{ kind: 'functions.function', key: 'us-central1-x' }] }, status),
      ).toBeUndefined()
    })
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

  it('send each card’s Connect to the snippet its app is written with', () => {
    expect(cardConnect('firestore')).toBe('web')
    expect(cardConnect('pubsub')).toBe('node')
    expect(cardConnect('tasks')).toBe('env')
    expect(cardConnect('logs')).toBeUndefined()
  })
})
