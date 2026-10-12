// The composer's drafts. The draft being written lives here, per topic, for
// as long as the tab does: closing the composer to read a message and
// opening it again finds the text where it was left. The ten drafts last
// published to a topic are kept per browser (localStorage, read and written
// in try/catch like `lib/layout.ts`), so the payload a developer sends again
// and again, editing it each time, is one click away after a reload too.

import { create } from 'zustand'
import { type KeyValueRow, rowId } from '@/components/console/key-value-editor'
import type { DataKind } from './payload'

/** Publish one by one at these intervals, or all at once. */
export const INTERVALS = [
  { ms: 0, label: 'at once' },
  { ms: 100, label: 'every 100 ms' },
  { ms: 1000, label: 'every second' },
  { ms: 5000, label: 'every 5 seconds' },
] as const

export type IntervalMs = (typeof INTERVALS)[number]['ms']

export interface ComposerDraft {
  kind: DataKind
  data: string
  attributes: KeyValueRow[]
  orderingKey: string
  /** How many copies, 1 to 1,000. */
  repeat: string
  intervalMs: IntervalMs
  /** The message a prefill came from, so a second prefill of it changes nothing. */
  prefilledFrom?: string | undefined
}

export function emptyDraft(kind: DataKind = 'json'): ComposerDraft {
  return {
    kind,
    data: kind === 'json' || kind === 'avro-json' ? '{\n  \n}' : '',
    attributes: [],
    orderingKey: '',
    repeat: '1',
    intervalMs: 0,
  }
}

interface ComposerState {
  drafts: Record<string, ComposerDraft>
  set: (key: string, draft: ComposerDraft) => void
  forget: (key: string) => void
}

/** The draft of each topic open in this tab, by `<project>|<topic>`. */
export const useComposer = create<ComposerState>((set) => ({
  drafts: {},
  set: (key, draft) => set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),
  forget: (key) =>
    set((state) => {
      const { [key]: _gone, ...drafts } = state.drafts
      return { drafts }
    }),
}))

export const draftKey = (project: string, topic: string) => `${project}|${topic}`

// ------------------------------------------------------------ recent drafts

/** Recent drafts kept per topic. */
export const RECENT_DRAFTS = 10

/** A published draft as it is remembered: no ids, no repeat. */
export interface RecentDraft {
  kind: DataKind
  data: string
  attributes: { key: string; value: string; enabled: boolean }[]
  orderingKey: string
  /** When it was published, RFC 3339. */
  at: string
}

const storageKey = (project: string, topic: string) =>
  `firenook.console.pubsub.drafts.${project}.${topic}`

export function readRecent(project: string, topic: string): RecentDraft[] {
  try {
    const raw = localStorage.getItem(storageKey(project, topic))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as RecentDraft[]).slice(0, RECENT_DRAFTS) : []
  } catch {
    return []
  }
}

/** Remembers a published draft first; the same draft published again moves up, not in twice. */
export function rememberDraft(
  project: string,
  topic: string,
  draft: ComposerDraft,
  now = new Date(),
) {
  const entry: RecentDraft = {
    kind: draft.kind,
    data: draft.data,
    attributes: draft.attributes
      .filter((row) => row.key !== '')
      .map((row) => ({ key: row.key, value: row.value, enabled: row.enabled })),
    orderingKey: draft.orderingKey,
    at: now.toISOString(),
  }
  const same = (other: RecentDraft) =>
    other.kind === entry.kind &&
    other.data === entry.data &&
    other.orderingKey === entry.orderingKey &&
    JSON.stringify(other.attributes) === JSON.stringify(entry.attributes)
  const next = [entry, ...readRecent(project, topic).filter((other) => !same(other))].slice(
    0,
    RECENT_DRAFTS,
  )
  try {
    localStorage.setItem(storageKey(project, topic), JSON.stringify(next))
  } catch {
    // A browser that refuses storage keeps no recent drafts.
  }
}

/** A remembered draft back into the composer. */
export function fromRecent(recent: RecentDraft): ComposerDraft {
  return {
    ...emptyDraft(recent.kind),
    data: recent.data,
    attributes: recent.attributes.map((row) => ({ ...row, id: rowId() })),
    orderingKey: recent.orderingKey,
  }
}

/** Attributes the engine wrote on a message: never copied into a new one. */
export function engineWritten(key: string): boolean {
  return key.startsWith('googclient_') || key.startsWith('CloudPubSubDeadLetter')
}
