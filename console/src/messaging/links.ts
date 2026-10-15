// Where Pub/Sub and Cloud Tasks things open: for each entity key another
// section's payload or a ⌘K hit carries (the kinds and keys of the
// messaging spec's §13), the search parameters of this section's own
// pages; and back, from those parameters to the resource a page shows. The
// two registry files import the first half, the pages the second, so a
// link and the page it opens cannot disagree. No other section imports
// this file: they link here with `EntityRef`s through `linkTo`.
//
// Pure string functions with no dependencies: the registries load with the
// first route, and this file with them.
//
// A link always names the project, because a registry cannot know the
// configured one (`?project=` naming it is not a foreign scope, so it opens
// the same page). A resource under an empty project segment
// (`projects//topics/t`, which the engine accepts) has no project to name,
// so its full name travels whole in the id's parameter. A Cloud Tasks link
// also always names the location; the page drops it from the URL once its
// queue list shows the id is not ambiguous in the project.

import { splitKey } from '@/lib/sections/keys'

export type ResourceCollection = 'topics' | 'subscriptions' | 'schemas'

/** `projects/<project>/<collection>/<id>` split, or null when `name` is not one. */
export function splitResourceName(
  name: string,
  collection: ResourceCollection,
): { project: string; id: string } | null {
  if (!name.startsWith('projects/')) return null
  const rest = name.slice('projects/'.length)
  const marker = `/${collection}/`
  const at = rest.indexOf(marker)
  if (at === -1) return null
  const project = rest.slice(0, at)
  const id = rest.slice(at + marker.length)
  if (id === '' || id.includes('/') || project.includes('/')) return null
  return { project, id }
}

/** A resource's full name from its parts. */
export function resourceName(project: string, collection: ResourceCollection, id: string): string {
  return `projects/${project}/${collection}/${id}`
}

/** The Pub/Sub page's parameters for a resource of `collection`, under `param`. */
function resourceSearch(
  name: string,
  collection: ResourceCollection,
  param: 'topic' | 'subscription' | 'schema',
): Record<string, string> {
  const parts = splitResourceName(name, collection)
  if (!parts) return {}
  if (parts.project === '') return { [param]: name }
  return { project: parts.project, [param]: parts.id }
}

/** `pubsub.topic` (the full name) → the Topics page on that topic. */
export function topicSearch(name: string): Record<string, string> {
  return resourceSearch(name, 'topics', 'topic')
}

/**
 * `pubsub.subscription` (the full name) → the Topics page on that
 * subscription. The key does not say its topic; the page completes `topic`
 * from its topics index.
 */
export function subscriptionSearch(name: string): Record<string, string> {
  return resourceSearch(name, 'subscriptions', 'subscription')
}

/** `pubsub.schema` (the full name) → the Schemas page on that schema. */
export function schemaSearch(name: string): Record<string, string> {
  return resourceSearch(name, 'schemas', 'schema')
}

/**
 * `pubsub.message` (`<topic full name>|<message id>`) → the Topics page on
 * that topic with the message open. Split at the last bar: an id is digits.
 */
export function messageSearch(key: string): Record<string, string> {
  const bar = key.lastIndexOf('|')
  if (bar === -1) return {}
  const id = key.slice(bar + 1)
  const topic = topicSearch(key.slice(0, bar))
  if (!/^\d+$/.test(id) || topic.topic === undefined) return {}
  return { ...topic, message: id }
}

/** `pubsub.schedule` (the function id) → the Schedules page with it open. */
export function scheduleSearch(functionId: string): Record<string, string> {
  return functionId === '' ? {} : { schedule: functionId }
}

/** `tasks.queue` (`<project>|<location>|<queue id>`) → the Cloud Tasks page on that queue. */
export function queueSearch(key: string): Record<string, string> {
  const [project, location, queue] = splitKey(key, 3)
  if (project === undefined || location === undefined || queue === undefined) return {}
  if (location === '' || queue === '') return {}
  return { project, queue, location }
}

/**
 * `tasks.task` (`<project>|<location>|<queue id>|<task id>`, the console's
 * decimal task id) → the Cloud Tasks page on that queue with the task open.
 */
export function taskSearch(key: string): Record<string, string> {
  const [project, location, queue, task] = splitKey(key, 4)
  if (task === undefined || !/^\d+$/.test(task)) return {}
  const address = queueSearch(`${project}|${location}|${queue}`)
  return address.queue === undefined ? {} : { ...address, task }
}

/**
 * The resource a Pub/Sub page shows from its parameters: an id under the
 * page's project (`?project=`, else the configured one), or a full name
 * that travelled whole.
 */
export function resourceFromSearch(
  value: string | undefined,
  collection: ResourceCollection,
  project: string,
): string | undefined {
  if (value === undefined || value === '') return undefined
  return value.startsWith('projects/') ? value : resourceName(project, collection, value)
}
