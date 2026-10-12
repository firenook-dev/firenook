// Pub/Sub resource names as the engine reads them (`crates/pubsub-front/
// src/names.rs`): `projects/{project}/{collection}/{id}`, the id 3–255
// characters, a letter first, only `A–Z a–z 0–9 - _ . ~ + %`, and not
// starting with `goog` — lowercase only: `GoogTopic` is a valid id, as the
// official emulator records it. The project segment may be anything, even
// empty. Checking here first lets a create dialog say what is wrong as the
// id is typed, in the engine's terms, before any request.

import type { PubsubSubscriptionSummary } from '@/api/generated/messaging/PubsubSubscriptionSummary'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import { type ResourceCollection, resourceName, splitResourceName } from '@/messaging/links'

export type { ResourceCollection } from '@/messaging/links'

/** The characters an id may hold besides letters and digits. */
const PUNCTUATION = '-_.~+%'

function isLetter(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')
}

function isIdChar(char: string): boolean {
  return isLetter(char) || (char >= '0' && char <= '9') || PUNCTUATION.includes(char)
}

/**
 * What is wrong with `id` as a topic, subscription, snapshot or schema id,
 * or undefined when the engine would take it. One sentence, the first
 * problem only, so the line under the field stays one line.
 */
export function idProblem(id: string): string | undefined {
  if (id.length === 0) return 'Enter an id.'
  // The engine counts bytes; any character past ASCII is refused anyway.
  const bad = [...id].find((char) => !isIdChar(char))
  if (bad !== undefined)
    return `${bad === ' ' ? 'A space' : `“${bad}”`} cannot be in an id: use letters, digits and - _ . ~ + %.`
  if (!isLetter(id[0] ?? '')) return 'An id starts with a letter.'
  if (id.length < 3) return 'An id has at least 3 characters.'
  if (id.length > 255) return `An id has at most 255 characters; this one has ${id.length}.`
  if (id.startsWith('goog')) return 'An id cannot start with goog.'
  return undefined
}

export function isValidId(id: string): boolean {
  return idProblem(id) === undefined
}

/** A resource's full name; the same function the links use, so the two cannot disagree. */
export function fullName(project: string, collection: ResourceCollection, id: string): string {
  return resourceName(project, collection, id)
}

/** The id at the end of a full name, or the text itself when it is not one. */
export function shortName(name: string | null | undefined): string {
  if (!name) return ''
  const at = name.lastIndexOf('/')
  return at === -1 ? name : name.slice(at + 1)
}

/** The project of a full name of `collection`, or undefined. */
export function projectOf(name: string, collection: ResourceCollection): string | undefined {
  return splitResourceName(name, collection)?.project
}

/**
 * What the page's `topic` / `subscription` parameter holds for a full name
 * shown under `project`: the id when the name is under that project, else
 * the whole name (a subscription can live in another project than its
 * topic, and a name under an empty project has nothing else to travel as).
 */
export function searchValue(name: string, collection: ResourceCollection, project: string): string {
  const parts = splitResourceName(name, collection)
  return parts && parts.project === project && parts.project !== '' ? parts.id : name
}

/** A subscription of the index by its full name, wherever it is listed. */
export function findSubscription(
  index: PubsubTopicIndex | undefined,
  name: string,
): PubsubSubscriptionSummary | undefined {
  if (!index) return undefined
  for (const topic of index.items)
    for (const subscription of topic.subscriptions)
      if (subscription.name === name) return subscription
  return index.detached.find((subscription) => subscription.name === name)
}

/** What a typed scope resolves to: a topic, a subscription, or both. */
export interface TypedScope {
  topic?: string
  subscription?: string
}

/**
 * What the path field's text names, against the topics index: a full
 * topic or subscription name, `topic/subscription`, or an id — a topic's
 * first, then a subscription's. Undefined when the index holds nothing by
 * that name.
 */
export function resolveTyped(
  text: string,
  index: PubsubTopicIndex | undefined,
  project: string,
): TypedScope | undefined {
  const typed = text.trim().replace(/^\/+|\/+$/g, '')
  if (!typed || !index) return undefined
  const topics = new Map(index.items.map((topic) => [topic.name, topic]))
  if (typed.startsWith('projects/')) {
    if (topics.has(typed)) return { topic: typed }
    const subscription = findSubscription(index, typed)
    if (subscription)
      return subscription.topic
        ? { topic: subscription.topic, subscription: subscription.name }
        : { subscription: subscription.name }
    return undefined
  }
  const [first, second] = typed.split('/')
  if (first === undefined) return undefined
  const topicName = fullName(project, 'topics', first)
  if (second !== undefined) {
    const topic = topics.get(topicName)
    const subscription = topic?.subscriptions.find((candidate) => candidate.id === second)
    return topic && subscription
      ? { topic: topic.name, subscription: subscription.name }
      : undefined
  }
  if (topics.has(topicName)) return { topic: topicName }
  const subscription = findSubscription(index, fullName(project, 'subscriptions', first))
  if (!subscription) return undefined
  return subscription.topic
    ? { topic: subscription.topic, subscription: subscription.name }
    : { subscription: subscription.name }
}

/** Completions for the path field: topic ids, and `topic/subscription` once a topic is typed. */
export function scopeCompletions(
  text: string,
  index: PubsubTopicIndex | undefined,
  limit = 12,
): { label: string; detail: string }[] {
  if (!index) return []
  const typed = text.trim().toLowerCase()
  const slash = typed.indexOf('/')
  if (slash !== -1) {
    const topicId = typed.slice(0, slash)
    const rest = typed.slice(slash + 1)
    const topic = index.items.find((candidate) => candidate.id.toLowerCase() === topicId)
    if (!topic) return []
    return topic.subscriptions
      .filter((subscription) => subscription.id.toLowerCase().startsWith(rest))
      .slice(0, limit)
      .map((subscription) => ({
        label: `${topic.id}/${subscription.id}`,
        detail: subscription.delivery,
      }))
  }
  const topics = index.items
    .filter((topic) => topic.id.toLowerCase().includes(typed))
    .toSorted((a, b) => {
      const ap = a.id.toLowerCase().startsWith(typed) ? 0 : 1
      const bp = b.id.toLowerCase().startsWith(typed) ? 0 : 1
      return ap - bp || a.id.localeCompare(b.id)
    })
    .slice(0, limit)
    .map((topic) => ({
      label: topic.id,
      detail:
        topic.subscriptions.length === 1
          ? '1 subscription'
          : `${topic.subscriptions.length} subscriptions`,
    }))
  return topics
}
