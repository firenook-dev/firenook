import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { z } from 'zod'
import { SectionFrame } from '@/components/console/section-gate'
import { zFlag } from '@/lib/search-params'
import { TopicsPage } from '@/pubsub/components/topics-page'

// Every view of the Topics page is a link: the scope (topic or
// subscription), its view, the open message and its inspector tab, the
// filters, and an open dialog.
//
// The router reads a query value as JSON first, so `message=40` arrives as
// the number 40 and `q=123` as 123; ids and free text are strings whatever
// they look like.
const text = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value))
  .optional()

const topicView = z.enum(['messages', 'subscriptions', 'settings'])
const subscriptionView = z.enum(['backlog', 'push', 'dead-letters', 'settings'])

const searchSchema = z.object({
  // The shell scope (useConsoleProject): the project whose topics are shown,
  // absent for the configured one.
  project: text,
  // Ids under the project above; a resource under another project than the
  // page's (a subscription on another project's topic, a name under an empty
  // project) travels as its full name.
  topic: text,
  subscription: text,
  // The scope's main-area tab: the topic's with no subscription, the
  // subscription's with one; a value from the other set falls back to the
  // scope's first.
  view: z.union([topicView, subscriptionView]).optional(),
  // A message id open in the inspector.
  message: text,
  // The inspector's tab.
  tab: z.enum(['data', 'attributes', 'deliveries']).optional(),
  // The shared filter grammar: id:, key:, attributes.<key>:, has:, is:, words.
  q: text,
  // A Pub/Sub filter expression over attributes, checked by the engine.
  expr: text,
  // Backlog narrowing (a single-choice switch with counts, not a filter).
  state: z.enum(['available', 'outstanding', 'pushing', 'acked']).optional(),
  // The Push feed is paused (absent: following).
  paused: zFlag,
  // A create dialog or the composer: `message` opens the composer.
  new: z.enum(['topic', 'subscription', 'message']).optional(),
  // Any other dialog a link can open.
  dialog: z.enum(['setup', 'export']).optional(),
  // With new=topic: the id to fill in. With new=message: the message id whose
  // data, attributes and key fill the composer.
  prefill: text,
})

/** Every parameter is absent by default, so a link carries only what differs. */
const DEFAULTS = {} as const

export type PubsubSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/pubsub')({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(DEFAULTS)] },
  component: PubsubTopicsRoute,
})

function PubsubTopicsRoute() {
  return (
    <SectionFrame section="pubsub">
      <TopicsPage />
    </SectionFrame>
  )
}
