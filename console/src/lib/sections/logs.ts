// Logs' registry entry, and the one way any section links into Logs:
// `linkToLogs`. The foundation created this file with the helper; the
// observe stream owns it from here (badges, `badgeLink`, routes, actions)
// and keeps the helper's signature.

import { ScrollIcon } from '@phosphor-icons/react'
import type { ConsoleSection, SectionLink } from '../services'

export const logs: ConsoleSection = {
  id: 'logs',
  to: '/logs',
  label: 'Logs',
  services: ['logging'],
  area: 'observe',
  icon: ScrollIcon,
  built: false,
  summary: 'One stream for every service with level and service filters and search.',
}

/** A value as the filter grammar reads it back: bare when it can be, else a quoted phrase. */
function filterValue(value: string): string {
  if (value !== '' && !/[\s"\\]/.test(value)) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** The terms `linkToLogs` writes into `q`, in this order. */
const TERMS = ['function', 'execution', 'instance', 'service', 'level'] as const

/**
 * A link to Logs filtered to these fields: the only link into another
 * section that is not an entity. `function`, `execution`, `instance`,
 * `service` and `level` become terms of `q` in Logs' canonical keys
 * (`function:us-central1-hello level:error`); `from`, `to`, `entry` and
 * `since` are Logs' own search params. Empty fields are left out.
 */
export function linkToLogs(filter: {
  function?: string
  execution?: string
  instance?: string
  service?: string
  level?: string
  from?: string
  to?: string
  entry?: string
  since?: string
}): SectionLink {
  const q = TERMS.flatMap((key) => {
    const value = filter[key]
    return value ? [`${key}:${filterValue(value)}`] : []
  }).join(' ')
  const search: Record<string, string> = {}
  if (q) search.q = q
  for (const key of ['from', 'to', 'entry', 'since'] as const) {
    const value = filter[key]
    if (value) search[key] = value
  }
  return Object.keys(search).length > 0 ? { to: '/logs', search } : { to: '/logs' }
}
