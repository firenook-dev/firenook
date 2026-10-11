// Engine types the live channel's foundation topics carry that the engine
// does not generate yet: the badges of the `shell` topic (engine commit 3,
// foundation spec §7.10) and the jobs of the `jobs` topic (engine commit 4b,
// §7.20). Each mirrors its pinned Rust shape field for field. When those
// commits land, `cargo test -p firenook-console-front` writes
// `api/generated/live/{Badge,BadgeSet,BadgeKind,BadgeTone,BadgeNoun}.ts` and
// `api/generated/{Job,JobState,JobError}.ts`; import those instead and delete
// this file (nothing else defines these names).

/** Singular and plural of what a badge counts, each read after a number. */
export interface BadgeNoun {
  one: string
  other: string
}

/** A running total since the engine started, or an amount now. */
export type BadgeKind = 'counter' | 'gauge'

/** How loudly a badge is drawn. */
export type BadgeTone = 'neutral' | 'attention' | 'danger'

/** A number the navigation shows beside a section or one of its pages. */
export interface Badge {
  /** `<section>.<what>`, for example `auth.inbox`. */
  id: string
  count: number
  kind: BadgeKind
  tone: BadgeTone
  noun: BadgeNoun
  /** Counters of ring entries only: the cursor of the newest counted entry. */
  cursor?: string
}

/** Every badge, as the `shell` topic sends it. */
export interface BadgeSet {
  badges: Badge[]
}

export type JobState = 'running' | 'done' | 'failed' | 'cancelled'

export interface JobError {
  key: string
  message: string
  /** The section's own detail for this item. */
  detail?: unknown
}

/** One piece of bulk work and how far it got. */
export interface Job {
  id: string
  /** `auth.delete-users`, `storage.move`, `suite.clear`. */
  kind: string
  section: string
  /** One line: "Delete 1,204 users". */
  title: string
  total: number | null
  done: number
  /** Items passed over on purpose, counted apart from failures. */
  skipped: number
  /** The first 20 failures, each with the key and why. */
  errors: JobError[]
  errorCount: number
  state: JobState
  startedAt: string
  finishedAt: string | null
}
