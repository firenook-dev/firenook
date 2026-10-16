// What the console calls each kind of line and how it treats it, read from
// the engine's own list (`LOG_KINDS`, generated from the `kinds` module of
// suite-front). The engine decides which kinds are problems (kept longer,
// counted, badged), markers (a divider in the feed) and engine internals
// (left out unless asked for); this file only adds the words the Kind facet
// and the inspector need, so the facet reads "Rules denials · 2" rather
// than a raw `rules.denied`.
//
// A kind the engine adds later still gets its engine label here: nothing
// breaks before someone writes it a plural.

import type { LogFacetCount } from '@/api/generated/observe/LogFacetCount'
import type { LogKindInfo } from '@/api/generated/observe/LogKindInfo'
import type { LogLevel } from '@/api/generated/observe/LogLevel'
import { LOG_KINDS } from '@/api/generated/observe/logKinds'

const BY_KIND: ReadonlyMap<string, LogKindInfo> = new Map(
  LOG_KINDS.map((info) => [info.kind, info]),
)

/**
 * The Kind facet's row labels: what the lines of a kind are, as a plural
 * noun phrase in sentence case. Engine internals have none — they share the
 * one "Engine internals" row.
 */
export const KIND_FACET_LABELS: Readonly<Record<string, string>> = {
  'engine.ready': 'Engine starts',
  'engine.notice': 'Engine notices',
  'functions.reloaded': 'Functions reloads',
  'hub.backgroundTriggers': 'Background trigger switches',
  'rules.denied': 'Rules denials',
  'rules.denied.console': 'Rules denials of console reads',
  'rules.reloaded': 'Rules reloads',
  'rules.fileError': 'Rules file errors',
  'rules.applied': 'Rules applied',
  'firestore.cleared': 'Firestore clears',
  'project.mismatch': 'Other project ids',
  'import.done': 'Imports',
  'data.exported': 'Exports',
  'data.reset': 'Resets',
  'diagnostics.omitted': 'Diagnostics left out',
  'function.start': 'Function starts',
  'function.finish': 'Function ends',
  'function.failed': 'Function failures',
  'function.timeout': 'Timeouts',
  'function.crashed': 'Crashes',
  'function.unknown': 'Calls to functions not loaded',
  'worker.failed': 'Workers that did not start',
  'eventarc.failed': 'Eventarc failures',
  'auth.message': 'Auth codes and links',
  'auth.config': 'Auth configuration changes',
  'storage.denied': 'Storage rules denials',
  'storage.denied.console': 'Storage denials of console reads',
  'storage.rules': 'Storage rules errors',
  'storage.flush': 'Storage save failures',
  'pubsub.schedule': 'Schedule failures',
  'pubsub.push': 'Push delivery failures',
  'tasks.failed': 'Task failures',
}

/** The label of the one facet row every engine internal shares. */
export const INTERNAL_FACET_LABEL = 'Engine internals'

/** How the console treats a kind: the engine's flags, as one word. */
export type KindGroup = 'problem' | 'marker' | 'internal' | 'plain'

/** The engine's description of `kind`, or `undefined` for one it never listed. */
export function kindInfo(kind: string): LogKindInfo | undefined {
  return BY_KIND.get(kind)
}

/** "Rules denied": the engine's label, or the raw kind when it has none. */
export function kindLabel(kind: string): string {
  return BY_KIND.get(kind)?.label ?? kind
}

/** "Rules denials": the Kind facet's row label (the engine's label when no plural is written). */
export function kindFacetLabel(kind: string): string {
  if (BY_KIND.get(kind)?.internal) return INTERNAL_FACET_LABEL
  return KIND_FACET_LABELS[kind] ?? kindLabel(kind)
}

export function kindGroup(kind: string | null | undefined): KindGroup {
  const info = kind ? BY_KIND.get(kind) : undefined
  if (!info) return 'plain'
  if (info.problem) return 'problem'
  if (info.internal) return 'internal'
  if (info.marker) return 'marker'
  return 'plain'
}

export const isProblemKind = (kind: string | null | undefined): boolean =>
  kind ? BY_KIND.get(kind)?.problem === true : false

export const isMarkerKind = (kind: string | null | undefined): boolean =>
  kind ? BY_KIND.get(kind)?.marker === true : false

export const isInternalKind = (kind: string | null | undefined): boolean =>
  kind ? BY_KIND.get(kind)?.internal === true : false

/**
 * A problem line, as the engine counts one (`is:problem`, the problem ring,
 * the Overview's recent problems): an error, or a line of a problem kind.
 */
export function isProblemLine(line: {
  level: LogLevel
  kind?: string | null | undefined
}): boolean {
  return line.level === 'error' || isProblemKind(line.kind)
}

/** The Kind facet, in the order it is shown. */
export interface KindFacets {
  /** Problem kinds, most lines first. */
  problems: LogFacetCount[]
  /** Every other kind but the internals, most lines first. */
  others: LogFacetCount[]
  /** Lines of engine internals the facets counted (they are one row, last). */
  internal: number
}

/**
 * Splits the engine's kind counts into the facet's groups: problem kinds
 * first, then the rest, and the internals summed into one row. Counts keep
 * the engine's order within a group (most lines first); a zero count is
 * dropped. `internalHidden` is what the default filter left out
 * (`LogFacets.internalHidden`); while the filter asks for internals it is
 * 0 and their own counts are in `counts`.
 */
export function kindFacets(counts: readonly LogFacetCount[], internalHidden = 0): KindFacets {
  const facets: KindFacets = { problems: [], others: [], internal: internalHidden }
  for (const count of counts) {
    if (count.count <= 0) continue
    const group = kindGroup(count.value)
    if (group === 'internal') facets.internal += count.count
    else if (group === 'problem') facets.problems.push(count)
    else facets.others.push(count)
  }
  return facets
}
