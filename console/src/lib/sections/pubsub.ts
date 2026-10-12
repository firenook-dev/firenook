// Pub/Sub's registry entry: three pages (Topics, Schemas, Schedules —
// schedules live here because a tick is a publish to the function's
// schedule topic, so a run, its message and its delivery are one story on
// one page), its badges, its ⌘K actions, and where a topic, subscription,
// schema, message or schedule opens when ⌘K finds one or another section's
// payload points at one. `built` stays false, and every page shows the
// placeholder, until the section's journeys pass (a browser asking for a
// preview, as the journeys do, sees what is built).

import {
  ArrowsDownUpIcon,
  BroadcastIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
} from '@phosphor-icons/react'
import {
  messageSearch,
  scheduleSearch,
  schemaSearch,
  subscriptionSearch,
  topicSearch,
} from '@/messaging/links'
import type { ConsoleSection, SectionLink } from '../services'

/**
 * Whether this browser asked to see the section before its journeys have
 * all passed: `firenook.console.preview` holding `pubsub` (the section's
 * own journeys set it; nobody else does). Read once, in try/catch, since
 * storage may refuse. Removed when the section is built for everyone.
 */
function previewing(id: string): boolean {
  try {
    return (localStorage.getItem('firenook.console.preview') ?? '').split(',').includes(id)
  } catch {
    return false
  }
}

/** The page itself when a key is not one this section knows. */
function open(to: string, search: Record<string, string>): SectionLink {
  return Object.keys(search).length === 0 ? { to } : { to, search }
}

export const pubsub: ConsoleSection = {
  id: 'pubsub',
  to: '/pubsub',
  label: 'Pub/Sub',
  services: ['pubsub'],
  area: 'messaging',
  icon: BroadcastIcon,
  // The Topics page is built and its journeys pass; Schemas and Schedules
  // are still on their way, so the section shows to the journeys only.
  built: previewing('pubsub'),
  summary:
    'Topics with their subscriptions and the functions they trigger, every message with who received it, a composer that publishes JSON, text or bytes with attributes, backlogs you can read without taking them, pull, replay and snapshots, Avro schemas with revisions, and the scheduled functions with run now and pause.',
  pages: [
    {
      to: '/pubsub',
      label: 'Topics',
      exact: true,
      badges: ['pubsub.rejected', 'pubsub.dead-lettered'],
      keywords: 'subscriptions messages publish pull backlog push dead letters snapshots',
    },
    { to: '/pubsub/schemas', label: 'Schemas', keywords: 'avro revisions' },
    { to: '/pubsub/schedules', label: 'Schedules', keywords: 'cron onSchedule scheduler' },
  ],
  // No badges of the section's own: its two counters are the Topics page's
  // (the heading's dot gathers them when the nav is collapsed), and the
  // heading carries the engine's automatic `pubsub.jobs` gauge while
  // publish, ack or release jobs run.
  // The API and topics take `project`, so the shell's "Show demo-other"
  // opens the topics an app wrote under another project id.
  projectScope: true,
  actions: [
    {
      id: 'pubsub.new-topic',
      title: 'Create a topic',
      icon: PlusIcon,
      link: { to: '/pubsub', search: { new: 'topic' } },
    },
    {
      id: 'pubsub.publish',
      title: 'Publish a message',
      icon: PaperPlaneTiltIcon,
      link: { to: '/pubsub', search: { new: 'message' } },
    },
    {
      id: 'pubsub.new-schema',
      title: 'Create a schema',
      icon: PlusIcon,
      link: { to: '/pubsub/schemas', search: { new: 'schema' } },
    },
    {
      id: 'pubsub.setup',
      title: 'Export or import the Pub/Sub setup',
      keywords: 'topics subscriptions schemas file',
      icon: ArrowsDownUpIcon,
      link: { to: '/pubsub', search: { dialog: 'setup' } },
    },
  ],
  searchLabels: {
    'pubsub.topic': 'Topics',
    'pubsub.subscription': 'Subscriptions',
    'pubsub.schema': 'Schemas',
    'pubsub.schedule': 'Schedules',
    'pubsub.message': 'Messages',
  },
  // The page's `q` filters one topic's messages; with no topic in the link
  // there is nothing for it to filter, and the engine's hits already name
  // every topic, subscription, schema and schedule the text matches.
  searchLink: null,
  routes: {
    // Keys: the full resource name.
    'pubsub.topic': (name) => open('/pubsub', topicSearch(name)),
    'pubsub.subscription': (name) => open('/pubsub', subscriptionSearch(name)),
    'pubsub.schema': (name) => open('/pubsub/schemas', schemaSearch(name)),
    // Key: the function id, `us-central1-nightlyCleanup`.
    'pubsub.schedule': (functionId) => open('/pubsub/schedules', scheduleSearch(functionId)),
    // Key: `<topic full name>|<message id>`.
    'pubsub.message': (key) => open('/pubsub', messageSearch(key)),
  },
}
