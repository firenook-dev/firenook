// Logs' registry entry, and the one way any section links into Logs:
// `linkToLogs`. The foundation created this file with the helper; the
// observe stream owns it (badges, `badgeLink`, routes, actions) and keeps
// the helper's signature.
//
// Logs is one page with no sub-pages: a problem list, one invocation or a
// time range are filters of the one stream, not other jobs. The Overview has
// no registry file of its own, so its suite-wide ⌘K actions (a snapshot, a
// reset, the environment block) are registered here and nowhere else.

import {
  ArrowCounterClockwiseIcon,
  DownloadSimpleIcon,
  PlugsConnectedIcon,
  ScrollIcon,
  WarningCircleIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import type { ConsoleSection, SectionLink } from '../services'

/**
 * The Logs filter keys `linkToLogs` writes, in the order it writes them:
 * each is a field's canonical key in the Logs filter (`LOG_FIELDS` in the
 * engine's `observe/fields.rs`, mirrored by `src/logs/fields.ts`), never an
 * alias (`fn:`, `exec:`, `ext:`), so a link reads the same in every tab and
 * in the filter field it lands in.
 */
export const LOGS_LINK_KEYS = ['function', 'execution', 'instance', 'service', 'level'] as const

/** The search params `linkToLogs` passes through as Logs' own. */
const LOGS_LINK_PARAMS = ['from', 'to', 'entry', 'since'] as const

/** What a link into Logs may narrow to. Empty fields are left out. */
export type LogsLinkFilter = Partial<
  Record<(typeof LOGS_LINK_KEYS)[number] | (typeof LOGS_LINK_PARAMS)[number], string>
>

/**
 * A value as the filter grammar reads it back: bare when it can be, else a
 * quoted phrase. Quoted when it is empty or holds whitespace or a quote, and
 * when it starts with `<`, `>` or `=`, which the grammar would read as a
 * comparison (`function:>x`).
 */
function filterValue(value: string): string {
  if (value !== '' && !/[\s"\\]/.test(value) && !/^[<>=]/.test(value)) return value
  return phrase(value)
}

/** `value` as a quoted phrase: backslashes and quotes escaped. */
function phrase(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * A link to Logs filtered to these fields: the only link into another
 * section that is not an entity. `function`, `execution`, `instance`,
 * `service` and `level` become terms of `q` in Logs' canonical keys
 * (`function:us-central1-hello level:error`); `from`, `to`, `entry` and
 * `since` are Logs' own search params. Empty fields are left out.
 */
export function linkToLogs(filter: LogsLinkFilter): SectionLink {
  const q = LOGS_LINK_KEYS.flatMap((key) => {
    const value = filter[key]
    return value ? [`${key}:${filterValue(value)}`] : []
  }).join(' ')
  const search: Record<string, string> = {}
  if (q) search.q = q
  for (const key of LOGS_LINK_PARAMS) {
    const value = filter[key]
    if (value) search[key] = value
  }
  return Object.keys(search).length > 0 ? { to: '/logs', search } : { to: '/logs' }
}

/**
 * What ⌘K's "Search Logs for “text”" opens: the text as words when it reads
 * as words, else as one quoted phrase — a pasted `TypeError: x is
 * undefined` or `/api/users` would otherwise parse as a filter term or a
 * regular expression and be refused.
 */
function searchLogs(text: string): SectionLink {
  const trimmed = text.trim()
  if (trimmed === '') return { to: '/logs' }
  const words = trimmed.split(/\s+/)
  const plain = words.every((word) => /^[^\s"/:=<>-][^\s":=]*$/.test(word))
  return { to: '/logs', search: { q: plain ? trimmed : phrase(trimmed) } }
}

export const logs: ConsoleSection = {
  id: 'logs',
  to: '/logs',
  label: 'Logs',
  services: ['logging'],
  area: 'observe',
  icon: ScrollIcon,
  built: true,
  summary:
    "Every service's log in one stream: filters with counts, structured payloads, each function invocation as a group, and links into the section a line is about.",
  badges: ['logs.errors'],
  // While errors are unseen the nav item opens on them, under a "New since
  // your last visit" marker after the newest error already seen.
  badgeLink: (seen) => ({
    to: '/logs',
    search: seen.cursor ? { q: 'level:error', since: seen.cursor } : { q: 'level:error' },
  }),
  routes: {
    'logs.entry': (cursor): SectionLink => ({ to: '/logs', search: { entry: cursor } }),
  },
  searchLink: searchLogs,
  actions: [
    {
      id: 'logs.errors',
      title: 'Open logs: errors only',
      description: 'Every error line from every service',
      keywords: 'logs errors failures level',
      icon: WarningCircleIcon,
      link: linkToLogs({ level: 'error' }),
    },
    {
      id: 'logs.problems',
      title: 'Open logs: problems',
      description: 'Errors, function failures and rules denials, kept longer than other lines',
      keywords: 'logs problems denials failures timeouts',
      icon: WarningIcon,
      link: { to: '/logs', search: { q: 'is:problem' } },
    },
    {
      id: 'overview.snapshot',
      title: 'Download a snapshot…',
      description: "The emulators' data as an export the engine imports with --import",
      keywords: 'snapshot export backup download data zip',
      icon: DownloadSimpleIcon,
      link: { to: '/', search: { dialog: 'snapshot' } },
    },
    {
      id: 'overview.reset',
      title: 'Reset data…',
      description: 'Delete the data of one section or of all of them',
      keywords: 'reset clear delete wipe data',
      icon: ArrowCounterClockwiseIcon,
      link: { to: '/', search: { dialog: 'reset' } },
    },
    {
      id: 'overview.env',
      title: 'Environment variables for your app',
      description: 'The variables the Admin SDKs and gcloud clients read to find the emulators',
      keywords: 'environment variables env connect admin sdk emulator host',
      icon: PlugsConnectedIcon,
      link: { to: '/', search: { connect: 'env' } },
    },
  ],
}
