// Engine types the console reads that the engine does not generate yet,
// each mirroring its pinned Rust shape field for field: the jobs of the
// `jobs` topic (engine commit 4b, foundation spec §7.20), the links between
// sections (`EntityRef`, commit 4b, §7.24) and ⌘K's engine search (commit 4,
// §7.13). When those commits land, `cargo test -p firenook-console-front`
// writes `api/generated/{Job,JobState,JobError,EntityRef,SearchResults,
// SearchGroup,SearchHit}.ts`; import those instead and delete this file
// (nothing else defines these names).

/** Something a section shows, as another section's payload points at it. */
export interface EntityRef {
  /** `<section>.<thing>`, one of the pinned kinds: `firestore.document`, `auth.user`. */
  kind: string
  /** What that section opens it by, in the pinned key format (`<db>|<path>`). */
  key: string
  /** The text to show, when it is not the key. */
  label?: string
}

/** One thing ⌘K can open. */
export interface SearchHit {
  /** One of the pinned `EntityRef` kinds. */
  kind: string
  key: string
  /** The line ⌘K shows. */
  title: string
  /** The quieter line beside it. */
  detail: string | null
}

/** One section's hits. */
export interface SearchGroup {
  section: string
  hits: SearchHit[]
}

/** What ⌘K found across the console (`GET /search?q=&limit=`). */
export interface SearchResults {
  /** One group per section with hits, in sidebar order. */
  groups: SearchGroup[]
  /** A section ran out of its time budget and is missing. */
  partial: boolean
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
