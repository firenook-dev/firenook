// The browser's test-event builders against the CLI's, imported directly:
// the same inputs give the same bodies, ids and times normalised.

import { describe, expect, it } from 'vitest'
// The CLI's own module, outside the console's sources: JavaScript, typed below as `CliModule`.
// @ts-expect-error -- a JavaScript module with no declarations
import * as cliModule from '../../../packages/cli/src/invoke.mjs'
import {
  type BackendDefinition,
  buildTestEvent,
  decodeFields,
  encodeFields,
  fitsPattern,
  matchParams,
  substituteParams,
  triggerKind,
} from './envelopes'

interface CliModule {
  buildEnvelope: (
    trigger: unknown,
    project: string,
    data: unknown,
    opts: object,
    services?: object,
  ) => Record<string, unknown>
  triggerKind: (trigger: unknown) => string
  substituteParams: (pattern: string, params?: object) => string
  matchParams: (pattern: string, path: string) => Record<string, string>
}

const cli = cliModule as CliModule

const PROJECT = 'demo-parity'
const IDS = new Set(['eventId', 'id', 'messageId', 'uid'])
const TIMES = new Set([
  'timestamp',
  'time',
  'createTime',
  'updateTime',
  'timeCreated',
  'updated',
  'timeStorageClassUpdated',
  'creationTime',
  'lastSignInTime',
  'x-cloudscheduler-scheduletime',
])

/** Every generated id, time and generation replaced by a word, so two builds compare. */
function normalise(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => normalise(item))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, normalise(item, name)]),
    )
  if (typeof value !== 'string') return value
  if (key === 'generation') return '<generation>'
  if (TIMES.has(key)) return '<time>'
  if (IDS.has(key)) return value.includes('/') ? value.replace(/\/\d+$/, '/<generation>') : '<id>'
  if (key === 'mediaLink') return value.replace(/generation=\d+/, 'generation=<generation>')
  return value
}

const definitions: Record<string, BackendDefinition> = {
  firestoreV1Create: {
    name: 'onOrderCreated',
    region: 'us-central1',
    platform: 'gcfv1',
    eventTrigger: {
      eventType: 'providers/cloud.firestore/eventTypes/document.create',
      resource: `projects/${PROJECT}/databases/(default)/documents/orders/{orderId}`,
    },
  },
  firestoreV1Update: {
    name: 'onOrderUpdated',
    platform: 'gcfv1',
    eventTrigger: {
      eventType: 'providers/cloud.firestore/eventTypes/document.update',
      resource: `projects/${PROJECT}/databases/(default)/documents/orders/{orderId}`,
    },
  },
  firestoreV1Delete: {
    name: 'onOrderDeleted',
    platform: 'gcfv1',
    eventTrigger: {
      eventType: 'providers/cloud.firestore/eventTypes/document.delete',
      resource: `projects/${PROJECT}/databases/(default)/documents/orders/{orderId}`,
    },
  },
  firestoreV2Written: {
    name: 'onOrderWritten',
    platform: 'gcfv2',
    eventTrigger: {
      eventType: 'google.cloud.firestore.document.v1.written',
      eventFilters: { database: '(default)', namespace: '(default)' },
      eventFilterPathPatterns: { document: 'orders/{orderId}' },
    },
  },
  firestoreV2CreatedAuth: {
    name: 'onOrderCreatedAuth',
    platform: 'gcfv2',
    eventTrigger: {
      eventType: 'google.cloud.firestore.document.v1.created.withAuthContext',
      eventFilters: { database: 'other' },
      eventFilterPathPatterns: { document: 'orders/{orderId}' },
    },
  },
  storageV1: {
    name: 'onUploadV1',
    platform: 'gcfv1',
    eventTrigger: {
      eventType: 'google.storage.object.finalize',
      resource: 'projects/_/buckets/b.appspot.com',
    },
  },
  storageV2: {
    name: 'onUpload',
    platform: 'gcfv2',
    eventTrigger: {
      eventType: 'google.cloud.storage.object.v1.finalized',
      eventFilters: { bucket: 'b.appspot.com' },
    },
  },
  pubsubV1: {
    name: 'onEmailV1',
    platform: 'gcfv1',
    eventTrigger: {
      eventType: 'google.pubsub.topic.publish',
      resource: `projects/${PROJECT}/topics/emails`,
    },
  },
  pubsubV2: {
    name: 'onEmail',
    platform: 'gcfv2',
    eventTrigger: {
      eventType: 'google.cloud.pubsub.topic.v1.messagePublished',
      eventFilters: { topic: `projects/${PROJECT}/topics/emails` },
    },
  },
  authV1: {
    name: 'onUserCreated',
    platform: 'gcfv1',
    eventTrigger: {
      eventType: 'providers/firebase.auth/eventTypes/user.create',
      resource: `projects/${PROJECT}`,
    },
  },
  scheduleV1: {
    name: 'nightlyV1',
    region: 'us-central1',
    platform: 'gcfv1',
    schedule: { schedule: 'every 5 minutes' },
    eventTrigger: { eventType: 'google.pubsub.topic.publish' },
  },
  scheduleV2: {
    name: 'nightly',
    region: 'us-central1',
    platform: 'gcfv2',
    schedule: { schedule: 'every 5 minutes' },
    eventTrigger: { eventType: 'pubsub' },
  },
  eventarc: {
    name: 'onGreeted',
    platform: 'gcfv2',
    eventTrigger: {
      eventType: 'test.greeter.v1.greeted',
      channel: `projects/${PROJECT}/locations/us-central1/channels/firebase`,
    },
  },
}

const cases: [string, unknown, object][] = [
  [
    'firestoreV1Create',
    { total: 12, items: ['mug'], when: { $timestamp: '2026-01-01T00:00:00Z' } },
    { params: { orderId: 'o_1' } },
  ],
  ['firestoreV1Update', { before: { total: 1 }, after: { total: 2 } }, { resource: 'orders/o_2' }],
  ['firestoreV1Delete', { total: 3 }, { params: { orderId: 'o_3' } }],
  ['firestoreV2Written', { after: { n: 1.5 }, before: null }, { params: { orderId: 'o_4' } }],
  ['firestoreV2CreatedAuth', { ok: true }, { resource: 'orders/o_5' }],
  ['storageV1', { name: 'a/b.png', contentType: 'image/png', size: 1024 }, {}],
  ['storageV2', { name: 'photo.png', generation: '7' }, {}],
  ['pubsubV1', { data: { to: 'ada' }, attributes: { kind: 'welcome' } }, {}],
  ['pubsubV2', { data: 'plain text', orderingKey: 'k' }, {}],
  ['authV1', { uid: 'u_1', email: 'ada@example.test' }, {}],
  ['scheduleV1', undefined, {}],
  ['scheduleV2', undefined, {}],
  ['eventarc', { name: 'Ada' }, {}],
]

describe('test events are the functions shell envelopes', () => {
  for (const [name, data, opts] of cases) {
    it(`${name} builds the CLI's body`, () => {
      const definition = definitions[name]
      if (!definition) throw new Error(name)
      const services = { storage: 'http://127.0.0.1:9199' }
      const expected = cli.buildEnvelope(definition, PROJECT, data, opts, services)
      const actual = buildTestEvent(definition, PROJECT, data, opts, services)
      expect(normalise(actual)).toEqual(normalise(expected))
      expect(triggerKind(definition)).toBe(cli.triggerKind(definition))
    })
  }

  it("refuses what the shell refuses, in the shell's words", () => {
    const http: BackendDefinition = { name: 'api', httpsTrigger: {} }
    expect(() => buildTestEvent(http, PROJECT, {})).toThrow(/is an HTTPS function/)
    const tasks: BackendDefinition = { name: 'resize', platform: 'gcfv2', taskQueueTrigger: {} }
    expect(() => buildTestEvent(tasks, PROJECT, {})).toThrow(/enqueue a task for it/)
    expect(triggerKind(tasks)).toBe(cli.triggerKind(tasks))
    expect(() =>
      buildTestEvent(
        { name: 'db', eventTrigger: { eventType: 'google.firebase.database.ref.v1.written' } },
        PROJECT,
        {},
      ),
    ).toThrow(/Realtime Database/)
    expect(() => buildTestEvent(definitions.storageV2 as BackendDefinition, PROJECT, {})).toThrow(
      /need the object/,
    )
    expect(() => buildTestEvent(definitions.pubsubV2 as BackendDefinition, PROJECT, {})).toThrow(
      /needs data or at least one attribute/,
    )
    expect(() =>
      buildTestEvent(
        definitions.firestoreV1Create as BackendDefinition,
        PROJECT,
        {},
        { resource: 'orders' },
      ),
    ).toThrow(/is not a document path/)
  })

  it('fills and reads wildcards as the shell does', () => {
    const params = { uid: 'alice', rest: 'a/b' }
    expect(substituteParams('users/{uid}/logs/{rest=**}', params)).toBe(
      cli.substituteParams('users/{uid}/logs/{rest=**}', params),
    )
    expect(matchParams('users/{uid}/logs/{rest=**}', 'users/alice/logs/a/b')).toEqual(
      cli.matchParams('users/{uid}/logs/{rest=**}', 'users/alice/logs/a/b'),
    )
    expect(substituteParams('users/{uid}', undefined, () => 0.5)).toBe('users/uid5')
    expect(fitsPattern('orders/{orderId}', 'orders/o1')).toBe(true)
    expect(fitsPattern('orders/{orderId}', 'users/o1')).toBe(false)
    expect(fitsPattern('logs/{rest=**}', 'logs/a/b')).toBe(true)
  })

  it('reads a stored document back as the data it was written from', () => {
    const data = {
      total: 12,
      ratio: 0.5,
      tags: ['a'],
      when: { $timestamp: '2026-01-01T00:00:00.000Z' },
      nested: { ok: true },
    }
    expect(decodeFields(encodeFields(data))).toEqual(data)
  })
})
