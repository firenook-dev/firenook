// What each part of the Overview shows, worked out from the engine's status,
// its badges and the overview state. Pure functions, so the components only
// draw and the rules — which sections get a card, what counts as a card's
// problem, which sections can be reset, how the header words the engine —
// are unit-tested in one place.

import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { DataFacts } from '@/api/generated/DataFacts'
import type { EngineInfo } from '@/api/generated/EngineInfo'
import type { Badge } from '@/api/generated/live/Badge'
import type { OverviewProblem } from '@/api/generated/observe/OverviewProblem'
import type { SectionFix } from '@/api/generated/SectionFix'
import type { SectionStatus } from '@/api/generated/SectionStatus'
import type { SectionSummary } from '@/api/generated/SectionSummary'
import type { ServiceStatus } from '@/api/generated/ServiceStatus'
import type { SummaryFigure } from '@/api/generated/SummaryFigure'
import { formatBytes, formatCount, formatDuration, formatNumber } from '@/lib/format'
import { linkTo } from '@/lib/links'
import { linkToLogs } from '@/lib/sections/logs'
import { type ConsoleSection, type SectionId, type SectionLink, sectionById } from '@/lib/services'
import type { ConnectParam } from '@/lib/connect-tabs'

/** A card's state: the dot and the word beside the section's name. */
export interface CardHealth {
  tone: 'success' | 'warning' | 'neutral'
  label: string
  /** On its way (starting): the dot breathes. */
  pulse: boolean
}

/** One current problem on a card: a gauge badge of the section above zero. */
export interface CardProblem {
  /** The badge's id (`firestore.rules`). */
  id: string
  /** "1 rules file does not compile", from the badge's own noun. */
  text: string
  /** The page that carries the badge. */
  link: SectionLink
}

/** A running section, as its card draws it. */
export interface SectionCard {
  section: ConsoleSection
  status: SectionStatus
  /** Where an app reaches the section's service; absent when the engine lists no port for it. */
  address: ServiceStatus | undefined
  /** The card before it that already shows this address (Extensions run in the Functions runtime). */
  sharedWith: ConsoleSection | undefined
  problems: CardProblem[]
  health: CardHealth
  /** The section's pages after its first, as links on the card ("Rules"). */
  pages: readonly { to: string; label: string }[]
  /**
   * The section's own lines in Logs: the Functions card's "Logs", as the
   * official Functions card linked to the log viewer. `null` for every
   * other section, and while Logs does not run.
   */
  logs: SectionLink | null
}

const PROBLEM = { one: 'problem', other: 'problems' }

/**
 * A card's problems: every gauge badge of the section (its registry's, its
 * pages', and any the engine publishes under its id) that is above zero
 * and not neutral — a gauge is a state now ("1 rules file does not
 * compile"); counters are news, which the nav says, not the card. Each links
 * to the page whose registry entry carries the badge.
 */
export function cardProblems(
  section: ConsoleSection,
  badges: ReadonlyMap<string, Badge>,
): CardProblem[] {
  const ids = new Set<string>([
    ...(section.badges ?? []),
    ...(section.pages ?? []).flatMap((page) => page.badges ?? []),
  ])
  for (const id of badges.keys()) if (id.startsWith(`${section.id}.`)) ids.add(id)
  const problems: CardProblem[] = []
  for (const id of ids) {
    const badge = badges.get(id)
    if (!badge || badge.kind !== 'gauge' || badge.tone === 'neutral' || badge.count <= 0) continue
    const page = section.pages?.find((candidate) => candidate.badges?.includes(id))
    problems.push({
      id,
      text: formatCount(badge.count, badge.noun),
      link: { to: page?.to ?? section.to },
    })
  }
  return problems
}

/** Starting, a count of problems, or running. */
export function cardHealth(status: SectionStatus, problems: readonly CardProblem[]): CardHealth {
  if (status.state === 'starting') return { tone: 'neutral', label: 'Starting', pulse: true }
  if (problems.length > 0)
    return { tone: 'warning', label: formatCount(problems.length, PROBLEM), pulse: false }
  return { tone: 'success', label: 'Running', pulse: false }
}

/** A card for every section the engine runs or is starting, in the sidebar's order. */
export function sectionCards(
  status: ConsoleStatus,
  badges: ReadonlyMap<string, Badge>,
): SectionCard[] {
  const cards: SectionCard[] = []
  const shown = new Map<string, ConsoleSection>()
  for (const entry of status.sections) {
    if (entry.state === 'absent') continue
    const section = sectionById(entry.id)
    if (!section) continue
    const service = section.services[0]
    const address =
      service === undefined
        ? undefined
        : status.services.find((candidate) => candidate.name === service)
    const sharedWith = service === undefined ? undefined : shown.get(service)
    if (service !== undefined && !sharedWith) shown.set(service, section)
    const problems = entry.state === 'ready' ? cardProblems(section, badges) : []
    cards.push({
      section,
      status: entry,
      address,
      sharedWith,
      problems,
      health: cardHealth(entry, problems),
      pages: (section.pages ?? []).slice(1),
      logs:
        entry.id === 'functions' && logsOpen(status) ? linkToLogs({ service: 'functions' }) : null,
    })
  }
  return cards
}

/** A figure as the card writes it: grouped, bytes as a size, "—" while it is still being counted. */
export function figureText(figure: SummaryFigure): string {
  if (figure.value === null) return '—'
  return figure.unit === 'bytes' ? formatBytes(figure.value) : formatNumber(figure.value)
}

/** The listeners no section owns, as the official port list names them. */
const INFRASTRUCTURE: readonly { name: string; label: string; about: string }[] = [
  {
    name: 'hub',
    label: 'Hub',
    about: 'Where the Firebase CLI and test harnesses find every emulator (FIREBASE_EMULATOR_HUB).',
  },
  {
    name: 'ui',
    label: 'Emulator UI',
    about: 'This console, with the Google Emulator UI still served at its root.',
  },
  {
    name: 'logging',
    label: 'Logging feed',
    about: 'The official log stream, a WebSocket the Google Emulator UI reads.',
  },
  {
    name: 'firestore.websocket',
    label: 'Firestore requests',
    about: 'The rules requests stream, a WebSocket the Google Emulator UI reads.',
  },
]

export interface InfrastructureEntry {
  name: string
  label: string
  about: string
  address: string
  /** The listener serving this page. */
  thisPage: boolean
}

/** `host:port`, with an IPv6 host in brackets. */
export function addressOf(service: Pick<ServiceStatus, 'host' | 'port'>): string {
  const host =
    service.host.includes(':') && !service.host.startsWith('[') ? `[${service.host}]` : service.host
  return `${host}:${service.port}`
}

/** The hub, this UI, the logging feed and the Firestore requests socket, where each listens. */
export function infrastructure(status: ConsoleStatus): InfrastructureEntry[] {
  return INFRASTRUCTURE.flatMap((entry) => {
    const service = status.services.find((candidate) => candidate.name === entry.name)
    return service ? [{ ...entry, address: addressOf(service), thisPage: entry.name === 'ui' }] : []
  })
}

/** A section this engine does not run, and the engine's words on why. */
export interface AbsentSection {
  section: ConsoleSection
  status: SectionStatus
  /** The engine's sentence, or a plain one when it gave none. */
  detail: string
}

export function absentSections(status: ConsoleStatus): AbsentSection[] {
  return status.sections.flatMap((entry) => {
    const section = entry.state === 'absent' ? sectionById(entry.id) : undefined
    return section
      ? [
          {
            section,
            status: entry,
            detail: entry.detail ?? `This engine does not run ${section.label}.`,
          },
        ]
      : []
  })
}

/** Absent sections that the same fixes turn on, and those fixes. */
export interface AbsentGroup {
  sections: AbsentSection[]
  fixes: SectionFix[]
}

/**
 * The absent sections, those with the very same fixes together, in the order
 * each group first appears: Functions, Extensions, Eventarc and Cloud Tasks
 * all come back with one `"functions"` entry, which is printed once under
 * the four reasons rather than four times. A section without a fix stands
 * alone.
 */
export function absentGroups(status: ConsoleStatus): AbsentGroup[] {
  const groups: AbsentGroup[] = []
  const byFixes = new Map<string, AbsentGroup>()
  for (const entry of absentSections(status)) {
    const fixes = entry.status.fixes
    const key = fixes.map((fix) => `${fix.kind}\u0000${fix.label}\u0000${fix.text}`).join('\u0001')
    const known = fixes.length > 0 ? byFixes.get(key) : undefined
    if (known) {
      known.sections.push(entry)
      continue
    }
    const group = { sections: [entry], fixes }
    groups.push(group)
    if (fixes.length > 0) byFixes.set(key, group)
  }
  return groups
}

/**
 * The sections the Overview offers to reset, each with the line it adds to
 * its confirmation, checked against that section's own `clear`. Firestore's
 * lines are its own (`resetFirestoreLines`).
 */
const RESETS: Partial<Record<SectionId, string | undefined>> = {
  firestore: undefined,
  auth: 'Codes and links already issued stay in the inbox.',
  storage: 'Storage rules are untouched.',
  pubsub: 'Topics your functions declare come back with the next inventory refresh.',
  tasks: 'Queues stay; their tasks are deleted.',
}

/** The line a section adds to its reset confirmation. */
export function resetConsequence(id: string): string | undefined {
  return Object.hasOwn(RESETS, id) ? RESETS[id as SectionId] : undefined
}

/**
 * The sections a reset can name now: those whose data the console can
 * clear (`RESETS`) and that are ready. `SectionStatus` does not say whether
 * a section implements `clear`; offering any other would answer "<Section>
 * cannot be cleared from the console."
 */
export function resettableSections(
  status: ConsoleStatus,
): { section: ConsoleSection; status: SectionStatus }[] {
  return status.sections.flatMap((entry) => {
    const section = sectionById(entry.id)
    if (!section || entry.state !== 'ready' || !Object.hasOwn(RESETS, entry.id)) return []
    return [{ section, status: entry }]
  })
}

/** A section whose summary says it holds nothing: its first figure is zero. */
export function holdsNothing(summary: SectionSummary | null): boolean {
  return summary?.figures[0]?.value === 0
}

/**
 * What a section holds, in one sentence: what its card says in place of
 * figures while the section's stream counts nothing, so the card reads as
 * the section it opens rather than an empty box. Never a number.
 */
const CARD_HOLDS: Record<SectionId, string> = {
  firestore: 'Documents in every database, and the rules that guard them.',
  auth: 'Users and tenants, and every code and link the emulator sends.',
  storage: 'Buckets and their objects, and the rules that guard them.',
  functions: 'HTTP, callable and background functions, and every invocation.',
  extensions: 'Extension instances from firebase.json, running beside your functions.',
  eventarc: 'Custom events published to channels, and the functions they reach.',
  pubsub: 'Topics and subscriptions, and every message published to them.',
  tasks: 'Queues and their tasks, dispatched to your functions.',
  logs: 'Every line every service logs, in one place.',
}

export function cardHolds(id: SectionId): string {
  return CARD_HOLDS[id]
}

/** The snippet a card's "Connect" opens: what an app of that section is written with. */
const CARD_CONNECT: Partial<Record<SectionId, ConnectParam>> = {
  firestore: 'web',
  auth: 'web',
  storage: 'web',
  functions: 'web',
  pubsub: 'node',
  eventarc: 'env',
  tasks: 'env',
}

export function cardConnect(id: SectionId): ConnectParam | undefined {
  return CARD_CONNECT[id]
}

/** "Firenook 0.2.0-next.3", or the build that has no release to name. */
export function engineName(engine: EngineInfo): string {
  return engine.version ? `${engine.name} ${engine.version}` : `${engine.name}, unreleased build`
}

/** How long the engine has run, to the minute: "under a minute", "14 min", "2 h 14 min". */
export function uptime(startedAt: string, now: number): string {
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return '—'
  const ms = Math.max(0, now - started)
  if (ms < 60_000) return 'under a minute'
  return formatDuration(ms - (ms % 60_000))
}

/** Where the data lives, in words: "on disk, resumed", "in memory". */
export function dataWords(data: DataFacts): string {
  const words = [data.mode === 'memory' ? 'in memory' : 'on disk']
  if (data.resumed) words.push('resumed')
  if (data.importedFrom) words.push('imported at start')
  return words.join(', ')
}

/**
 * A configuration notice as a banner says it: the engine's first sentence
 * as the title, the rest as the description. A one-sentence notice is a
 * title alone.
 */
export function noticeParts(message: string): { title: string; description: string | undefined } {
  const split = /^(.+?[.!?])\s+(?=[A-Z])([\s\S]+)$/.exec(message.trim())
  if (!split?.[1] || !split[2]) return { title: message.trim(), description: undefined }
  return { title: split[1], description: split[2] }
}

/**
 * The one link a recent problem's row ends with: why a rules denial was
 * refused ("See why"), else the first thing it is about that opens in its
 * section. `undefined` when nothing it names opens yet.
 */
export function problemLink(
  problem: Pick<OverviewProblem, 'refs'>,
  status?: ConsoleStatus,
): { link: SectionLink; label: string; kind: string; key: string } | undefined {
  const decision = problem.refs.find((ref) => ref.kind.endsWith('.decision'))
  const decided = decision ? linkTo(decision, status) : null
  if (decision && decided)
    return { link: decided, label: 'See why', kind: decision.kind, key: decision.key }
  for (const ref of problem.refs) {
    if (ref.kind.endsWith('.decision')) continue
    const link = linkTo(ref, status)
    if (link) return { link, label: ref.label ?? ref.key, kind: ref.kind, key: ref.key }
  }
  return undefined
}

/** Where a line opens in Logs (`/logs?entry=`); `null` while Logs is absent. */
export function logsEntryLink(cursor: string, status?: ConsoleStatus): SectionLink | null {
  return linkTo({ kind: 'logs.entry', key: cursor }, status)
}

/** Whether a link into Logs opens: this engine runs it. */
function logsOpen(status?: ConsoleStatus): boolean {
  return status?.sections.find((entry) => entry.id === 'logs')?.state !== 'absent'
}

/** Where "Open logs" goes from the recent problems; `null` while Logs is absent. */
export function logsProblemsLink(status?: ConsoleStatus): SectionLink | null {
  return logsOpen(status) ? { to: '/logs', search: { q: 'is:problem' } } : null
}
