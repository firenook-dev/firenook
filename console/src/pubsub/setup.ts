// A project's Pub/Sub setup as a file (PS-90, PS-91): what the export holds
// and leaves out, a file read back and checked before anything is created,
// and what the import would do with each thing in it — so the dialog says
// all of that before a single request, and the engine's own answer after.
//
// The engine writes the file (`GET /pubsub/setup`): topics, subscriptions
// and schemas with every revision in order, never messages, and never what
// the functions create for themselves — a scheduled function's
// `firebase-schedule-*` topic and the `emulator-sub-*` subscription of each
// topic a function listens on. A file written by hand may still hold them;
// the import leaves them out, because the functions would make them again.

import type { PubsubCreateSubscriptionBody } from '@/api/generated/messaging/PubsubCreateSubscriptionBody'
import type { PubsubCreateTopicBody } from '@/api/generated/messaging/PubsubCreateTopicBody'
import type { PubsubSetup } from '@/api/generated/messaging/PubsubSetup'
import type { PubsubSetupResult } from '@/api/generated/messaging/PubsubSetupResult'
import type { PubsubSetupSchema } from '@/api/generated/messaging/PubsubSetupSchema'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import { formatNumber } from '@/lib/format'
import { splitResourceName } from '@/messaging/links'
import { shortName } from './names'

/** The setup file's version the engine writes and reads. */
export const SETUP_VERSION = 2

/** The file the export saves as. */
export const SETUP_FILENAME = 'pubsub-setup.json'

/** The topic a scheduled function's ticks are published to starts with this. */
export const SCHEDULE_TOPIC_PREFIX = 'firebase-schedule-'

/** The subscription the Functions emulator drains for a topic starts with this. */
export const FUNCTIONS_SUBSCRIPTION_PREFIX = 'emulator-sub-'

export interface SetupCounts {
  topics: number
  subscriptions: number
  schemas: number
  revisions: number
}

/** Something the file does not carry (export) or the import does not create, and why. */
export interface LeftOut {
  kind: 'topic' | 'subscription'
  name: string
  reason: string
}

export function setupCounts(setup: Pick<PubsubSetup, 'topics' | 'subscriptions' | 'schemas'>) {
  return {
    topics: setup.topics.length,
    subscriptions: setup.subscriptions.length,
    schemas: setup.schemas.length,
    revisions: setup.schemas.reduce((sum, schema) => sum + schema.revisions.length, 0),
  } satisfies SetupCounts
}

function plural(count: number, one: string, other = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : other}`
}

/** "4 topics, 6 subscriptions and 1 schema with 3 revisions"; "nothing" when empty. */
export function countsText(counts: SetupCounts): string {
  const parts: string[] = []
  if (counts.topics > 0) parts.push(plural(counts.topics, 'topic'))
  if (counts.subscriptions > 0) parts.push(plural(counts.subscriptions, 'subscription'))
  if (counts.schemas > 0)
    parts.push(`${plural(counts.schemas, 'schema')} with ${plural(counts.revisions, 'revision')}`)
  if (parts.length === 0) return 'nothing'
  if (parts.length === 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`
}

const SCHEDULE_REASON = 'A scheduled function’s topic: the function creates it.'
const FUNCTIONS_REASON = 'The functions’ own subscription: the emulator creates it for them.'
const ORPHANED_REASON =
  'The functions’ own subscription, though no function listens any more: the emulator made it.'

/**
 * What the export leaves out of `project`'s setup: the schedule topics and
 * the functions' own subscriptions, as the topics index lists them.
 */
export function exportLeftOut(index: PubsubTopicIndex | undefined): LeftOut[] {
  if (!index) return []
  const out: LeftOut[] = []
  for (const topic of index.items) {
    if (topic.kind === 'schedule') {
      out.push({ kind: 'topic', name: topic.name, reason: SCHEDULE_REASON })
      continue
    }
    for (const subscription of topic.subscriptions)
      if (subscription.managed !== 'no')
        out.push({
          kind: 'subscription',
          name: subscription.name,
          reason: subscription.managed === 'functions' ? FUNCTIONS_REASON : ORPHANED_REASON,
        })
  }
  return out
}

// ------------------------------------------------------------ reading a file

export type ParsedSetup = { ok: true; setup: PubsubSetup } | { ok: false; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function named(value: unknown): value is { name: string } {
  return isRecord(value) && typeof value.name === 'string' && value.name !== ''
}

/**
 * A file's text as a setup, or what is wrong with it in one sentence. The
 * shape is checked as far as the preview needs; the engine checks every
 * field again when it creates them.
 */
export function parseSetup(text: string): ParsedSetup {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      message: `This file is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.topics) ||
    !Array.isArray(value.subscriptions) ||
    !Array.isArray(value.schemas)
  )
    return {
      ok: false,
      message:
        'This file is not a Pub/Sub setup: it has no topics, subscriptions and schemas lists. Export one from this dialog.',
    }
  if (value.version !== SETUP_VERSION)
    return {
      ok: false,
      message: `This setup is version ${typeof value.version === 'number' ? value.version : 'unknown'}; the console imports version ${SETUP_VERSION}. Export it again from the console.`,
    }
  if (typeof value.project !== 'string')
    return { ok: false, message: 'This setup does not say which project it is from.' }
  const topic = value.topics.findIndex((item) => !named(item))
  if (topic !== -1) return { ok: false, message: `Topic ${topic + 1} of the file has no name.` }
  const subscription = value.subscriptions.findIndex(
    (item) => !named(item) || typeof (item as { topic?: unknown }).topic !== 'string',
  )
  if (subscription !== -1)
    return {
      ok: false,
      message: `Subscription ${subscription + 1} of the file has no name or no topic.`,
    }
  const schema = value.schemas.findIndex((item: unknown) => {
    if (!named(item)) return true
    const revisions = (item as { revisions?: unknown }).revisions
    return (
      !Array.isArray(revisions) ||
      !revisions.every(
        (revision: unknown) =>
          isRecord(revision) &&
          typeof revision.id === 'string' &&
          typeof revision.definition === 'string',
      )
    )
  })
  if (schema !== -1)
    return {
      ok: false,
      message: `Schema ${schema + 1} of the file has no name, or a revision without its id and definition.`,
    }
  return { ok: true, setup: value as unknown as PubsubSetup }
}

// ------------------------------------------------------------ another project

/** `projects/<from>/…` → `projects/<to>/…`; any other name as it is. */
function moved(name: string, from: string, to: string): string {
  const prefix = `projects/${from}/`
  return name.startsWith(prefix) ? `projects/${to}/${name.slice(prefix.length)}` : name
}

/**
 * The setup with every name under the file's project moved to `to`: topics,
 * subscriptions, their topics and dead-letter topics, schemas and the
 * topics' schema bindings. Names under another project stay as they are.
 */
export function moveProject(setup: PubsubSetup, to: string): PubsubSetup {
  const from = setup.project
  if (from === to) return setup
  const move = (name: string) => moved(name, from, to)
  return {
    ...setup,
    project: to,
    schemas: setup.schemas.map((schema) => ({ ...schema, name: move(schema.name) })),
    topics: setup.topics.map((topic) => ({
      ...topic,
      name: move(topic.name),
      ...(topic.schema ? { schema: { ...topic.schema, schema: move(topic.schema.schema) } } : {}),
    })),
    subscriptions: setup.subscriptions.map((subscription) => ({
      ...subscription,
      name: move(subscription.name),
      topic: move(subscription.topic),
      ...(subscription.deadLetter
        ? { deadLetter: { ...subscription.deadLetter, topic: move(subscription.deadLetter.topic) } }
        : {}),
    })),
  }
}

// ------------------------------------------------------------ the import's preview

/** Every project a setup's names are under (a hand-written file may mix them). */
export function setupProjects(setup: PubsubSetup): string[] {
  const projects = new Set<string>()
  const add = (name: string, collection: 'topics' | 'subscriptions' | 'schemas') => {
    const parts = splitResourceName(name, collection)
    if (parts) projects.add(parts.project)
  }
  for (const schema of setup.schemas) add(schema.name, 'schemas')
  for (const topic of setup.topics) add(topic.name, 'topics')
  for (const subscription of setup.subscriptions) add(subscription.name, 'subscriptions')
  return [...projects].toSorted()
}

/** What already exists in the engine, by full name. */
export interface Existing {
  topics: ReadonlySet<string>
  subscriptions: ReadonlySet<string>
  schemas: ReadonlySet<string>
}

/** The names a topics index and a schema list hold. */
export function existingFrom(
  indexes: readonly (PubsubTopicIndex | undefined)[],
  schemas: readonly (readonly { name: string }[] | undefined)[],
): Existing {
  const topics = new Set<string>()
  const subscriptions = new Set<string>()
  for (const index of indexes) {
    if (!index) continue
    for (const topic of index.items) {
      topics.add(topic.name)
      for (const subscription of topic.subscriptions) subscriptions.add(subscription.name)
    }
    for (const subscription of index.detached) subscriptions.add(subscription.name)
  }
  const names = new Set<string>()
  for (const list of schemas) for (const schema of list ?? []) names.add(schema.name)
  return { topics, subscriptions, schemas: names }
}

export type ImportStatus = 'create' | 'exists' | 'left-out'

export interface ImportItem {
  kind: 'schema' | 'topic' | 'subscription'
  name: string
  status: ImportStatus
  /** What it is, in a few words: "3 revisions, replayed in order", "on orders". */
  detail: string
  /** Why the engine will refuse it although it is to be created. */
  warning?: string | undefined
  /** Why it is left out. */
  reason?: string | undefined
}

function isScheduleTopic(name: string): boolean {
  return shortName(name).startsWith(SCHEDULE_TOPIC_PREFIX)
}

function isFunctionsSubscription(name: string): boolean {
  return shortName(name).startsWith(FUNCTIONS_SUBSCRIPTION_PREFIX)
}

function schemaDetail(schema: PubsubSetupSchema): string {
  const count = schema.revisions.length
  return count === 1 ? '1 revision' : `${formatNumber(count)} revisions, replayed in order`
}

function topicDetail(topic: PubsubCreateTopicBody): string {
  const parts: string[] = []
  if (topic.schema)
    parts.push(
      `${shortName(topic.schema.schema)} · ${topic.schema.encoding === 'BINARY' ? 'binary' : 'JSON'}`,
    )
  if (topic.retentionSeconds) parts.push('keeps messages')
  const labels = Object.keys(topic.labels ?? {}).length
  if (labels > 0) parts.push(plural(labels, 'label'))
  return parts.join(' · ')
}

function subscriptionDetail(subscription: PubsubCreateSubscriptionBody): string {
  const parts = [`on ${shortName(subscription.topic)}`]
  if (subscription.pushEndpoint) parts.push('push')
  if (subscription.filter) parts.push('filtered')
  if (subscription.deadLetter)
    parts.push(`dead letters to ${shortName(subscription.deadLetter.topic)}`)
  return parts.join(' · ')
}

/**
 * What the import would do with each thing in the file, in the order it
 * does it: schemas, topics, subscriptions. Something that exists is
 * skipped by the engine; what the functions create is left out here; a
 * subscription whose topic is neither in the file nor in the engine is
 * created only to be refused, and says so.
 */
export function importPreview(setup: PubsubSetup, existing: Existing): ImportItem[] {
  const items: ImportItem[] = []
  const topicsInFile = new Set<string>()
  for (const schema of setup.schemas)
    items.push({
      kind: 'schema',
      name: schema.name,
      status: existing.schemas.has(schema.name) ? 'exists' : 'create',
      detail: schemaDetail(schema),
    })
  for (const topic of setup.topics) {
    if (isScheduleTopic(topic.name)) {
      items.push({
        kind: 'topic',
        name: topic.name,
        status: 'left-out',
        detail: topicDetail(topic),
        reason: SCHEDULE_REASON,
      })
      continue
    }
    topicsInFile.add(topic.name)
    const binding = topic.schema?.schema
    const schemaMissing =
      binding !== undefined &&
      !existing.schemas.has(binding) &&
      !setup.schemas.some((schema) => schema.name === binding)
    items.push({
      kind: 'topic',
      name: topic.name,
      status: existing.topics.has(topic.name) ? 'exists' : 'create',
      detail: topicDetail(topic),
      ...(schemaMissing
        ? {
            warning: `Its schema ${shortName(binding)} is neither in the file nor in the emulator, so the engine will refuse it.`,
          }
        : {}),
    })
  }
  for (const subscription of setup.subscriptions) {
    if (isFunctionsSubscription(subscription.name)) {
      items.push({
        kind: 'subscription',
        name: subscription.name,
        status: 'left-out',
        detail: subscriptionDetail(subscription),
        reason: FUNCTIONS_REASON,
      })
      continue
    }
    const topicMissing =
      !topicsInFile.has(subscription.topic) && !existing.topics.has(subscription.topic)
    items.push({
      kind: 'subscription',
      name: subscription.name,
      status: existing.subscriptions.has(subscription.name) ? 'exists' : 'create',
      detail: subscriptionDetail(subscription),
      ...(topicMissing
        ? {
            warning: `Its topic ${shortName(subscription.topic)} is neither in the file nor in the emulator, so the engine will refuse it.`,
          }
        : {}),
    })
  }
  return items
}

/** The setup without what the import leaves out: what is sent to the engine. */
export function importable(setup: PubsubSetup): PubsubSetup {
  return {
    ...setup,
    topics: setup.topics.filter((topic) => !isScheduleTopic(topic.name)),
    subscriptions: setup.subscriptions.filter(
      (subscription) => !isFunctionsSubscription(subscription.name),
    ),
  }
}

/** How many of each status a preview holds. */
export function previewCounts(items: readonly ImportItem[]): Record<ImportStatus, number> {
  const counts: Record<ImportStatus, number> = { create: 0, exists: 0, 'left-out': 0 }
  for (const item of items) counts[item.status] += 1
  return counts
}

/** The import's answer in one line: "Created 9; 2 skipped". */
export function resultText(result: PubsubSetupResult): string {
  const created = result.created.length
  const skipped = result.skipped.length
  if (created === 0 && skipped === 0) return 'Nothing to create.'
  const parts: string[] = []
  parts.push(created === 0 ? 'Nothing created' : `Created ${formatNumber(created)}`)
  if (skipped > 0) parts.push(`${formatNumber(skipped)} skipped`)
  return `${parts.join('; ')}.`
}
