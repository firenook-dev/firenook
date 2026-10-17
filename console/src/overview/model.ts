// What each part of the Overview shows, worked out from the engine's status,
// its badges and the overview state. Pure functions, so the components only
// draw and the rules — which sections get a card, what counts as a card's
// problem, which sections can be reset, how the header words the engine —
// are unit-tested in one place.

import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { DataFacts } from '@/api/generated/DataFacts'
import type { Badge } from '@/api/generated/live/Badge'
import type { OverviewProblem } from '@/api/generated/observe/OverviewProblem'
import type { SectionStatus } from '@/api/generated/SectionStatus'
import type { SectionSummary } from '@/api/generated/SectionSummary'
import type { ServiceStatus } from '@/api/generated/ServiceStatus'
import type { SummaryFigure } from '@/api/generated/SummaryFigure'
import { formatBytes, formatCount, formatDuration, formatNumber } from '@/lib/format'
import { linkTo } from '@/lib/links'
import { type ConsoleSection, type SectionId, type SectionLink, sectionById } from '@/lib/services'

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

/** A section, as its tile on the Overview draws it. */
export interface SectionCard {
  section: ConsoleSection
  status: SectionStatus
  /** Where an app reaches the section's service; absent when the engine lists no port for it. */
  address: ServiceStatus | undefined
  /** The tile before it that already shows this address (Extensions run in the Functions runtime). */
  sharedWith: ConsoleSection | undefined
  problems: CardProblem[]
  health: CardHealth
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

/** Not running, starting, a count of problems, or running. */
export function cardHealth(status: SectionStatus, problems: readonly CardProblem[]): CardHealth {
  if (status.state === 'absent') return { tone: 'neutral', label: 'Not running', pulse: false }
  if (status.state === 'starting') return { tone: 'neutral', label: 'Starting', pulse: true }
  if (problems.length > 0)
    return { tone: 'warning', label: formatCount(problems.length, PROBLEM), pulse: false }
  return { tone: 'success', label: 'Running', pulse: false }
}

/**
 * A tile for every section, in the sidebar's order: the ones the engine
 * runs or is starting, and the ones it does not, which keep their place so
 * the grid is the same shape on every engine and an absent section reads as
 * a gap in a known set rather than a missing card.
 */
export function sectionCards(
  status: ConsoleStatus,
  badges: ReadonlyMap<string, Badge>,
): SectionCard[] {
  const cards: SectionCard[] = []
  const shown = new Map<string, ConsoleSection>()
  for (const entry of status.sections) {
    const section = sectionById(entry.id)
    if (!section) continue
    const service = entry.state === 'absent' ? undefined : section.services[0]
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
    })
  }
  return cards
}

/** The whole suite in one line, for the page's header. */
export interface SuiteHealth {
  tone: CardHealth['tone']
  /** "All 9 services running", "8 running, 1 starting", "9 running · 1 needs attention". */
  label: string
  pulse: boolean
}

const SERVICE = { one: 'service', other: 'services' }

export function suiteHealth(cards: readonly SectionCard[]): SuiteHealth {
  const running = cards.filter((card) => card.status.state === 'ready').length
  const starting = cards.filter((card) => card.status.state === 'starting').length
  const absent = cards.filter((card) => card.status.state === 'absent').length
  const troubled = cards.filter((card) => card.problems.length > 0).length
  if (starting > 0)
    return { tone: 'neutral', label: `${running} running, ${starting} starting`, pulse: true }
  if (troubled > 0)
    return {
      tone: 'warning',
      label: `${running} running · ${formatCount(troubled, SERVICE)} ${troubled === 1 ? 'needs' : 'need'} attention`,
      pulse: false,
    }
  if (running === 0) return { tone: 'neutral', label: 'No services running', pulse: false }
  return {
    tone: 'success',
    label:
      absent === 0
        ? `All ${formatCount(running, SERVICE)} running`
        : `${formatCount(running, SERVICE)} running`,
    pulse: false,
  }
}

/**
 * The host every tile's address shares, so each tile can show its port
 * alone and the host is written once; `undefined` when they differ (a
 * service bound elsewhere), and each tile then shows its whole address.
 */
export function sharedHost(cards: readonly SectionCard[]): string | undefined {
  const hosts = new Set(cards.flatMap((card) => (card.address ? [card.address.host] : [])))
  return hosts.size === 1 ? [...hosts][0] : undefined
}

/** What a tile shows for its address: the port alone when the host is the shared one. */
export function tileAddress(service: ServiceStatus, host: string | undefined): string {
  return service.host === host ? `:${service.port}` : addressOf(service)
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
    label: 'Console',
    about:
      'This console. The root of the port leads here, and so do the Google Emulator UI’s old addresses.',
  },
  {
    name: 'logging',
    label: 'Logging feed',
    about: 'The official log stream, a WebSocket kept for the tools that read it.',
  },
  {
    name: 'firestore.websocket',
    label: 'Firestore requests',
    about: 'The official rules requests stream, a WebSocket kept for the tools that read it.',
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

/** What a reset confirmation names: one section, or every one that can be reset. */
export type ResetTarget = { kind: 'section'; id: string } | { kind: 'everything' }

/**
 * The reset a link opens (`?dialog=reset`, with `section` when another
 * page names one): that section while it can be reset (nothing when it
 * cannot, so a link never resets something else); without one, the only
 * section there is, or all of them.
 */
export function linkedReset(
  resettable: readonly { section: Pick<ConsoleSection, 'id'> }[],
  section: string | undefined,
): ResetTarget | undefined {
  if (section !== undefined)
    return resettable.some((entry) => entry.section.id === section)
      ? { kind: 'section', id: section }
      : undefined
  const [only] = resettable
  if (resettable.length === 1 && only) return { kind: 'section', id: only.section.id }
  return resettable.length > 0 ? { kind: 'everything' } : undefined
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

/** How long the engine has run, to the minute: "under a minute", "14 min", "2 h 14 min". */
export function uptime(startedAt: string, now: number): string {
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return '—'
  const ms = Math.max(0, now - started)
  if (ms < 60_000) return 'under a minute'
  return formatDuration(ms - (ms % 60_000))
}

/**
 * A long path with its middle taken out, so the end — the folder that
 * names it — stays in sight: `/work/…/apps/web-firebase`. The first
 * segment and the last `keep` are kept; a path that short is returned
 * whole. Shown only; a copy takes the whole path.
 */
export function shortPath(path: string, keep = 3): string {
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const parts = path.split(separator)
  // A rooted path starts with an empty segment: keep the root and the one after it.
  const head = parts[0] === '' ? 2 : 1
  if (parts.length <= head + keep + 1) return path
  return [...parts.slice(0, head), '…', ...parts.slice(-keep)].join(separator)
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
