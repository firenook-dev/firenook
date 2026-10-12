// What the navigation's badges show (foundation spec §7.10, §10.2).
//
// The engine publishes every badge on the `shell` topic (`useBadges`). A
// gauge is an amount now ("1 rules file does not compile") and shows while
// it is above zero. A counter is a running total since the engine started
// ("new codes and links"), and the nav shows how much it grew since this
// browser last looked: the seen record is kept per project and per engine
// instance in localStorage, so a restart (a new instance) never hides the
// new run's count behind the old run's seen value, and every tab of the
// browser follows the same record through the `storage` event. A page marks
// its badges seen while it is mounted and visible, so the badge of the page
// you are reading never grows. A tab's own work ("3 uploading") is a local
// badge, merged in and gone with the tab.

import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { create } from 'zustand'
import type { Badge } from '@/api/generated/live/Badge'
import type { BadgeNoun } from '@/api/generated/live/BadgeNoun'
import type { BadgeTone } from '@/api/generated/live/BadgeTone'
import { statusQuery } from '@/api/queries'
import { formatNumber } from './format'
import { useBadges } from './live/shell'
import { sectionById } from './services'

export const SEEN_KEY = 'firenook.console.badges-seen'

/** What this browser last saw of one counter badge. */
export interface SeenRecord {
  /** The engine run it was seen on; another run's record does not count. */
  instance: string
  count: number
  /** The newest counted entry's cursor at the time (`Badge.cursor`). */
  cursor?: string
}

/** Seen records by project, then badge id. */
export type SeenStore = Record<string, Record<string, SeenRecord>>

/** A badge for this tab's own work, merged with the engine's. */
export interface LocalBadge {
  count: number
  tone: BadgeTone
  noun: BadgeNoun
}

function readSeen(): SeenStore {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as SeenStore)
      : {}
  } catch {
    // Unreadable or refused storage: nothing seen yet.
    return {}
  }
}

function writeSeen(seen: SeenStore): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    // A browser that refuses storage keeps the record for this tab only.
  }
}

/** This browser's seen records, kept in step with every other tab's. */
export const useSeen = create<{ seen: SeenStore }>(() => ({ seen: readSeen() }))

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === SEEN_KEY || event.key === null) useSeen.setState({ seen: readSeen() })
  })
}

/** This tab's local badges by id. */
export const useLocalBadges = create<{ badges: ReadonlyMap<string, LocalBadge> }>(() => ({
  badges: new Map(),
}))

/**
 * What a badge shows now: a gauge its count; a counter what it grew since
 * the seen record of this engine run (all of it when there is none).
 */
export function unseenCount(
  badge: Pick<Badge, 'kind' | 'count'>,
  seen: SeenRecord | undefined,
  instance: string | undefined,
): number {
  if (badge.kind === 'gauge') return badge.count
  if (!seen || instance === undefined || seen.instance !== instance) return badge.count
  return Math.max(0, badge.count - seen.count)
}

const LOUDNESS: Record<BadgeTone, number> = { neutral: 0, attention: 1, danger: 2 }

/** The nav's answer for one item. */
export interface NavBadgeView {
  /** The sum of the shown badges of the loudest tone present. */
  count: number
  tone: BadgeTone
  /** Every shown badge as a sentence: the tooltip and the accessible name. */
  label: string
  /** The first counter's seen record, for the registry's `badgeLink`. */
  seen: { count: number; cursor?: string }
  /** Whether a counter badge is among those shown (`badgeLink` applies only then). */
  counter: boolean
}

interface Entry {
  id: string
  kind: 'counter' | 'gauge'
  value: number
  tone: BadgeTone
  noun: BadgeNoun
}

/** "3 new codes and links since you last opened Authentication". */
function sentence(entry: Entry): string {
  const noun = entry.value === 1 ? entry.noun.one : entry.noun.other
  const said = `${formatNumber(entry.value)} ${noun}`
  if (entry.kind === 'gauge') return said
  const section = sectionById(entry.id.split('.')[0] ?? '')
  return `${said} since you last opened ${section?.label ?? entry.id.split('.')[0]}`
}

/**
 * The pure core of `useNavBadge`: for these ids, the engine's badges and the
 * tab's local ones, against the seen records of `instance`.
 */
export function summarizeBadges(options: {
  ids: readonly string[]
  engine: ReadonlyMap<string, Badge>
  local: ReadonlyMap<string, LocalBadge>
  seen: Record<string, SeenRecord> | undefined
  instance: string | undefined
}): NavBadgeView | undefined {
  const entries: Entry[] = []
  let first: SeenRecord | undefined
  let firstCounter = true
  for (const id of options.ids) {
    const badge = options.engine.get(id)
    if (badge) {
      const record = options.seen?.[id]
      const current = record && record.instance === options.instance ? record : undefined
      if (badge.kind === 'counter' && firstCounter) {
        first = current
        firstCounter = false
      }
      const value = unseenCount(badge, record, options.instance)
      if (value > 0)
        entries.push({ id, kind: badge.kind, value, tone: badge.tone, noun: badge.noun })
    }
    const local = options.local.get(id)
    if (local && local.count > 0)
      entries.push({ id, kind: 'gauge', value: local.count, tone: local.tone, noun: local.noun })
  }
  if (entries.length === 0) return undefined
  const tone = entries.reduce<BadgeTone>(
    (loudest, entry) => (LOUDNESS[entry.tone] > LOUDNESS[loudest] ? entry.tone : loudest),
    'neutral',
  )
  const count = entries
    .filter((entry) => entry.tone === tone)
    .reduce((sum, entry) => sum + entry.value, 0)
  return {
    count,
    tone,
    label: entries.map(sentence).join('; '),
    seen: first
      ? { count: first.count, ...(first.cursor ? { cursor: first.cursor } : {}) }
      : { count: 0 },
    counter: entries.some((entry) => entry.kind === 'counter'),
  }
}

/**
 * What the nav shows for these badge ids now: the loudest tone present, the
 * sum of that tone's badges, every badge as one sentence, and the seen
 * record `badgeLink` reads. Merges the engine's badges with this tab's.
 */
export function useNavBadge(ids: readonly string[] | undefined): NavBadgeView | undefined {
  const engine = useBadges((state) => state.badges)
  const local = useLocalBadges((state) => state.badges)
  const status = useQuery(statusQuery)
  const project = status.data?.projectId
  const seen = useSeen((state) => (project ? state.seen[project] : undefined))
  if (!ids || ids.length === 0) return undefined
  return summarizeBadges({ ids, engine, local, seen, instance: status.data?.instance })
}

/**
 * Counter badges count from here on this browser: records each counter's
 * current count (and cursor) for this project and engine run, for every tab.
 * Gauges have nothing to mark. Writes nothing when nothing moved.
 */
export function markSeen(project: string, instance: string, ids: readonly string[]): void {
  const badges = useBadges.getState().badges
  const all = readSeen()
  const records = { ...all[project] }
  let changed = false
  for (const id of ids) {
    const badge = badges.get(id)
    if (badge?.kind !== 'counter') continue
    const known = records[id]
    if (
      known?.instance === instance &&
      known.count === badge.count &&
      known.cursor === badge.cursor
    )
      continue
    records[id] = {
      instance,
      count: badge.count,
      ...(badge.cursor ? { cursor: badge.cursor } : {}),
    }
    changed = true
  }
  if (!changed) return
  const next = { ...all, [project]: records }
  writeSeen(next)
  useSeen.setState({ seen: next })
}

/**
 * Marks `ids` seen now and on every badge update while the calling page is
 * mounted and the tab visible, so the badge of the page being read never
 * grows; a tab coming back into view catches up at once.
 */
export function useMarkSeen(ids: readonly string[]): void {
  const status = useQuery(statusQuery)
  const project = status.data?.projectId
  const instance = status.data?.instance
  const key = ids.join(' ')
  useEffect(() => {
    if (!project || !instance || key === '') return
    const list = key.split(' ')
    const mark = () => {
      if (document.visibilityState === 'visible') markSeen(project, instance, list)
    }
    mark()
    // Every badge update while this page is on screen: no render needed.
    const stop = useBadges.subscribe(mark)
    document.addEventListener('visibilitychange', mark)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', mark)
    }
  }, [project, instance, key])
}

/**
 * A badge for this tab's own work (Storage's "3 uploading"), merged by
 * `useNavBadge` while the calling component is mounted; `undefined` takes it
 * down.
 */
export function useLocalBadge(id: string, badge: LocalBadge | undefined): void {
  const count = badge?.count
  const tone = badge?.tone
  const one = badge?.noun.one
  const other = badge?.noun.other
  useEffect(() => {
    if (count === undefined || tone === undefined || one === undefined || other === undefined)
      return
    useLocalBadges.setState((state) => {
      const next = new Map(state.badges)
      next.set(id, { count, tone, noun: { one, other } })
      return { badges: next }
    })
    return () =>
      useLocalBadges.setState((state) => {
        const next = new Map(state.badges)
        next.delete(id)
        return { badges: next }
      })
  }, [id, count, tone, one, other])
}
