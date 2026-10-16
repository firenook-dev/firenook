// The message list's filter fields: the shared grammar's `key:value` terms
// this page understands, exactly the specs the engine validates with
// (`console-front/src/messaging/pubsub/filters.rs`, pinned by
// `message-filter-cases.json` on both sides), plus what only the browser
// can add — completions from what the topic has seen. The attributes
// expression (`expr`) is not a term of this grammar: it is a Pub/Sub filter
// the engine parses with its own parser, and it travels untouched.

import type { FilterFieldSpec } from '@/components/console/filter-field'

/** The fields as the engine declares them (the golden file's `fields`, with their help). */
export const MESSAGE_FIELDS: readonly FilterFieldSpec[] = [
  { key: 'id', kind: 'number', help: 'Message id' },
  {
    key: 'key',
    aliases: ['orderingkey'],
    kind: 'exact',
    help: 'Ordering key (a trailing * matches the start)',
  },
  {
    key: 'attributes',
    aliases: ['attribute'],
    kind: 'path',
    help: 'An attribute, by its key',
    prefixes: ['attributes.'],
  },
  {
    key: 'has',
    kind: 'enum',
    help: 'Messages that carry an ordering key, a schema or attributes',
    values: ['key', 'schema', 'attributes'],
  },
  {
    key: 'is',
    kind: 'enum',
    help: 'Dead-lettered, binary or JSON messages',
    values: ['dead-lettered', 'binary', 'json'],
    valueAliases: { deadlettered: 'dead-lettered' },
  },
]

/** What the topic has seen, for completion: its attribute keys and its ordering keys. */
export interface MessageSuggestions {
  attributeKeys: readonly string[]
  orderingKeys: readonly string[]
}

function startingWith(values: readonly string[], prefix: string): string[] {
  const lower = prefix.toLowerCase()
  return values.filter((value) => value.toLowerCase().startsWith(lower))
}

/** The fields with completions from the topic: attribute keys after `attributes.`, ordering keys after `key:`. */
export function messageFields(seen: MessageSuggestions): FilterFieldSpec[] {
  const completions: Record<string, readonly string[]> = {
    attributes: seen.attributeKeys,
    key: seen.orderingKeys,
  }
  const fields: FilterFieldSpec[] = []
  for (const field of MESSAGE_FIELDS) {
    const values = completions[field.key]
    fields.push(
      values
        ? Object.assign({}, field, { suggest: (prefix: string) => startingWith(values, prefix) })
        : field,
    )
  }
  return fields
}

/** The placeholder that teaches the grammar with this page's own fields. */
export const MESSAGE_FILTER_PLACEHOLDER =
  'Filter messages — key:cust-1 attributes.region:eu id:>120 words'

/**
 * The expression a subscription's Dead letters tab reads its dead-letter
 * topic with: the source the engine writes on each forwarded message, by
 * id and project (two projects may hold a subscription of one id).
 */
export function deadLetterExpression(subscriptionId: string, project: string): string {
  return `attributes.CloudPubSubDeadLetterSourceSubscription = ${JSON.stringify(subscriptionId)} AND attributes.CloudPubSubDeadLetterSourceSubscriptionProject = ${JSON.stringify(project)}`
}
