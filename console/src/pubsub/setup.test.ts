// U-08: the setup's export preview (counts, what the functions create left
// out) and its import preview (create, exists, left out), plus reading a
// file and moving it to another project.

import { describe, expect, it } from 'vitest'
import type { PubsubSetup } from '@/api/generated/messaging/PubsubSetup'
import {
  countsText,
  existingFrom,
  exportLeftOut,
  importPreview,
  importable,
  moveProject,
  parseSetup,
  previewCounts,
  resultText,
  setupCounts,
  setupProjects,
} from './setup'
import {
  PROJECT,
  subscriptionSummary,
  topicIndex,
  topicSummary,
} from './index-fixture.test-support'

const topic = (id: string, project = PROJECT) => `projects/${project}/topics/${id}`
const subscription = (id: string, project = PROJECT) => `projects/${project}/subscriptions/${id}`
const schema = (id: string, project = PROJECT) => `projects/${project}/schemas/${id}`

function setup(overrides: Partial<PubsubSetup> = {}): PubsubSetup {
  return {
    version: 2,
    project: PROJECT,
    schemas: [
      {
        name: schema('order-event'),
        kind: 'AVRO',
        revisions: [
          { id: 'aaaa1111', definition: '{"type":"string"}' },
          { id: 'bbbb2222', definition: '{"type":"int"}' },
          { id: 'cccc3333', definition: '{"type":"long"}' },
        ],
      },
    ],
    topics: [
      {
        name: topic('orders'),
        schema: {
          schema: schema('order-event'),
          encoding: 'JSON',
          firstRevisionId: 'aaaa1111',
          lastRevisionId: 'cccc3333',
        },
      },
      { name: topic('orders-dead') },
    ],
    subscriptions: [
      {
        name: subscription('orders-worker'),
        topic: topic('orders'),
        deadLetter: { topic: topic('orders-dead'), maxDeliveryAttempts: 5 },
      },
    ],
    ...overrides,
  }
}

describe('the export preview', () => {
  it('counts what the file holds, revisions of every schema included', () => {
    const counts = setupCounts(setup())
    expect(counts).toEqual({ topics: 2, subscriptions: 1, schemas: 1, revisions: 3 })
    expect(countsText(counts)).toBe('2 topics, 1 subscription and 1 schema with 3 revisions')
    expect(countsText({ topics: 1, subscriptions: 0, schemas: 0, revisions: 0 })).toBe('1 topic')
    expect(countsText({ topics: 0, subscriptions: 0, schemas: 0, revisions: 0 })).toBe('nothing')
  })

  it('names the function-managed resources it leaves out, and why', () => {
    const index = topicIndex([
      topicSummary('orders', {
        subscriptions: [
          subscriptionSummary('orders-worker', 'orders'),
          subscriptionSummary('emulator-sub-orders', 'orders', { managed: 'functions' }),
        ],
      }),
      topicSummary('firebase-schedule-nightlyCleanup', { kind: 'schedule' }),
      topicSummary('old', {
        subscriptions: [subscriptionSummary('emulator-sub-old', 'old', { managed: 'orphaned' })],
      }),
    ])
    const out = exportLeftOut(index)
    expect(out.map((item) => [item.kind, item.name])).toEqual([
      ['subscription', subscription('emulator-sub-orders')],
      ['topic', topic('firebase-schedule-nightlyCleanup')],
      ['subscription', subscription('emulator-sub-old')],
    ])
    expect(out[0]?.reason).toContain('functions’ own')
    expect(out[1]?.reason).toContain('scheduled function')
    expect(out[2]?.reason).toContain('no function listens')
    expect(exportLeftOut(undefined)).toEqual([])
  })
})

describe('reading a file', () => {
  it('takes a version 2 setup', () => {
    const parsed = parseSetup(JSON.stringify(setup()))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.setup.schemas[0]?.revisions).toHaveLength(3)
  })

  it('says what is wrong, in one sentence', () => {
    expect(parseSetup('{').ok).toBe(false)
    const notJson = parseSetup('{')
    if (!notJson.ok) expect(notJson.message).toMatch(/^This file is not JSON: /)
    const notSetup = parseSetup('{"users":[]}')
    if (!notSetup.ok) expect(notSetup.message).toMatch(/not a Pub\/Sub setup/)
    const old = parseSetup(JSON.stringify({ ...setup(), version: 1 }))
    if (!old.ok)
      expect(old.message).toBe(
        'This setup is version 1; the console imports version 2. Export it again from the console.',
      )
    expect(old.ok).toBe(false)
    const nameless = parseSetup(JSON.stringify({ ...setup(), topics: [{ name: '' }] }))
    if (!nameless.ok) expect(nameless.message).toBe('Topic 1 of the file has no name.')
    const topicless = parseSetup(
      JSON.stringify({ ...setup(), subscriptions: [{ name: subscription('s') }] }),
    )
    if (!topicless.ok) expect(topicless.message).toMatch(/^Subscription 1 /)
    const revisionless = parseSetup(
      JSON.stringify({ ...setup(), schemas: [{ name: schema('x'), revisions: [{ id: 'a' }] }] }),
    )
    if (!revisionless.ok) expect(revisionless.message).toMatch(/^Schema 1 /)
    expect([nameless.ok, topicless.ok, revisionless.ok]).toEqual([false, false, false])
  })
})

describe('the import preview', () => {
  it('says what is created, in the order the engine creates it', () => {
    const items = importPreview(setup(), existingFrom([], []))
    expect(items.map((item) => [item.kind, item.status, item.detail])).toEqual([
      ['schema', 'create', '3 revisions, replayed in order'],
      ['topic', 'create', 'order-event · JSON'],
      ['topic', 'create', ''],
      ['subscription', 'create', 'on orders · dead letters to orders-dead'],
    ])
    expect(items.every((item) => item.warning === undefined)).toBe(true)
  })

  it('marks what exists already, which the engine skips', () => {
    const existing = existingFrom(
      [
        topicIndex([
          topicSummary('orders', {
            subscriptions: [subscriptionSummary('orders-worker', 'orders')],
          }),
        ]),
      ],
      [[{ name: schema('order-event') }]],
    )
    const items = importPreview(setup(), existing)
    expect(items.map((item) => item.status)).toEqual(['exists', 'exists', 'create', 'exists'])
    expect(previewCounts(items)).toEqual({ create: 1, exists: 3, 'left-out': 0 })
  })

  it('leaves out what the functions create, and sends the rest', () => {
    const file = setup({
      topics: [{ name: topic('firebase-schedule-tick') }, { name: topic('orders') }],
      subscriptions: [
        { name: subscription('emulator-sub-orders'), topic: topic('orders') },
        { name: subscription('orders-worker'), topic: topic('orders') },
      ],
    })
    const items = importPreview(file, existingFrom([], []))
    expect(items.filter((item) => item.status === 'left-out').map((item) => item.name)).toEqual([
      topic('firebase-schedule-tick'),
      subscription('emulator-sub-orders'),
    ])
    const sent = importable(file)
    expect(sent.topics.map((item) => item.name)).toEqual([topic('orders')])
    expect(sent.subscriptions.map((item) => item.name)).toEqual([subscription('orders-worker')])
  })

  it('warns of what the engine will refuse: a missing topic or schema', () => {
    const file = setup({
      schemas: [],
      subscriptions: [{ name: subscription('lonely'), topic: topic('nowhere') }],
    })
    const items = importPreview(file, existingFrom([], []))
    expect(items.find((item) => item.name === topic('orders'))?.warning).toMatch(
      /schema order-event is neither in the file nor in the emulator/,
    )
    expect(items.find((item) => item.name === subscription('lonely'))?.warning).toMatch(
      /topic nowhere is neither in the file nor in the emulator/,
    )
  })

  it('moves a file from another project, names under other projects kept', () => {
    const file = setup({
      project: 'demo-other',
      schemas: [{ name: schema('event', 'demo-other'), kind: 'AVRO', revisions: [] }],
      topics: [
        {
          name: topic('orders', 'demo-other'),
          schema: { schema: schema('event', 'demo-other'), encoding: 'BINARY' },
        },
        { name: topic('shared', 'elsewhere') },
      ],
      subscriptions: [
        {
          name: subscription('worker', 'demo-other'),
          topic: topic('orders', 'demo-other'),
          deadLetter: { topic: topic('dead', 'demo-other'), maxDeliveryAttempts: 5 },
        },
      ],
    })
    expect(setupProjects(file)).toEqual(['demo-other', 'elsewhere'])
    const moved = moveProject(file, PROJECT)
    expect(moved.project).toBe(PROJECT)
    expect(moved.schemas[0]?.name).toBe(schema('event'))
    expect(moved.topics.map((item) => item.name)).toEqual([
      topic('orders'),
      topic('shared', 'elsewhere'),
    ])
    expect(moved.topics[0]?.schema?.schema).toBe(schema('event'))
    expect(moved.subscriptions[0]).toMatchObject({
      name: subscription('worker'),
      topic: topic('orders'),
      deadLetter: { topic: topic('dead'), maxDeliveryAttempts: 5 },
    })
    expect(moveProject(file, 'demo-other')).toBe(file)
  })

  it('reads the engine’s answer in one line', () => {
    expect(
      resultText({ created: ['a', 'b'], skipped: [{ name: 'c', reason: 'x' }], revisions: [] }),
    ).toBe('Created 2; 1 skipped.')
    expect(resultText({ created: [], skipped: [{ name: 'c', reason: 'x' }], revisions: [] })).toBe(
      'Nothing created; 1 skipped.',
    )
    expect(resultText({ created: [], skipped: [], revisions: [] })).toBe('Nothing to create.')
  })
})
