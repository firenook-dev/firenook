// The Eventarc events filter's fields — the `q` of `/eventarc/events` and
// of the `eventarc.events` topic — exactly as the engine declares them
// (`crates/console-front/src/compute/filters.rs`, `EVENT_FIELDS`). Both
// sides are held to `event-filter-cases.json`, so a filter means one thing
// in the field and in the engine. `type` completes from the types the
// channels publish and listen for.

import type { FilterFieldSpec } from '@/components/console/filter-field'

/** Every way an event can end up, as `delivery:` takes it. */
export const DELIVERY_WORDS = ['delivered', 'filtered', 'unheard', 'failed', 'pending'] as const

/** The event filter's fields, with completions for event types when the page has them. */
export function eventFields(types: () => readonly string[] = () => []): FilterFieldSpec[] {
  const startingWith = (prefix: string) =>
    types().filter((type) => type.toLowerCase().startsWith(prefix.toLowerCase()))
  return [
    {
      key: 'type',
      kind: 'exact',
      help: 'Event type; end with * for a prefix',
      suggest: startingWith,
    },
    { key: 'source', kind: 'exact', help: 'CloudEvent source' },
    { key: 'subject', kind: 'exact', help: 'CloudEvent subject' },
    { key: 'publisher', kind: 'exact', help: 'Extension instance that published it' },
    {
      key: 'origin',
      kind: 'enum',
      help: 'Who published it',
      values: ['console', 'replay', 'app'],
    },
    {
      key: 'delivery',
      kind: 'enum',
      help: 'What became of it',
      values: [...DELIVERY_WORDS],
    },
    { key: 'at', kind: 'time', help: 'When it arrived' },
  ]
}

/** `delivery:failed` in `q`, on or off: what `e` toggles on the events page. */
export function toggleFailed(q: string): string {
  const terms = q.split(/\s+/).filter(Boolean)
  const at = terms.indexOf('delivery:failed')
  if (at === -1) return [...terms, 'delivery:failed'].join(' ')
  return terms.toSpliced(at, 1).join(' ')
}
