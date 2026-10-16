// The counters topics' frames, kept a moment after they arrive. A frame
// patches the cached list it belongs to (the topics index, the queue list)
// only when it is newer than that list's revision; but a list being read
// again while frames arrive comes back read at an older revision than the
// newest frame, and would undo what they patched. So each list's query
// function catches up with the frames newer than what it read before it
// hands the list over, and nothing on screen goes back in time.
//
// Bounded: the newest 32 frames per scope, none older than ten seconds —
// longer than any read of a list takes. An engine restart clears them all,
// since a new instance counts its revisions from zero.

import { liveChannel } from '@/lib/live/channel'

/** What every counters frame carries: the engine revision it was read at. */
export interface RevisionFrame {
  revision: number
}

export interface FrameLog<F extends RevisionFrame> {
  /** Keeps a frame of `scope` (a project), as it arrived. */
  record(scope: string, frame: F): void
  /** The frames of `scope` newer than `revision`, oldest first. */
  newerThan(scope: string, revision: number): F[]
  /** Forgets `scope`'s frames, or every scope's. */
  clear(scope?: string): void
}

export const FRAME_LIMIT = 32
export const FRAME_AGE_MS = 10_000

export function createFrameLog<F extends RevisionFrame>(
  options: { limit?: number; maxAgeMs?: number; now?: () => number } = {},
): FrameLog<F> {
  const limit = options.limit ?? FRAME_LIMIT
  const maxAge = options.maxAgeMs ?? FRAME_AGE_MS
  const now = options.now ?? Date.now
  const scopes = new Map<string, { at: number; frame: F }[]>()
  const fresh = (scope: string) => {
    const kept = scopes.get(scope)
    if (!kept) return []
    const since = now() - maxAge
    const recent = kept.filter((entry) => entry.at >= since)
    if (recent.length === 0) scopes.delete(scope)
    else if (recent.length !== kept.length) scopes.set(scope, recent)
    return recent
  }
  return {
    record(scope, frame) {
      const kept = [...fresh(scope), { at: now(), frame }]
      scopes.set(scope, kept.length > limit ? kept.slice(kept.length - limit) : kept)
    },
    newerThan(scope, revision) {
      return fresh(scope)
        .filter((entry) => entry.frame.revision > revision)
        .map((entry) => entry.frame)
    },
    clear(scope) {
      if (scope === undefined) scopes.clear()
      else scopes.delete(scope)
    },
  }
}

/** A log that an engine restart empties (every log the section keeps is one). */
export function createLiveFrameLog<F extends RevisionFrame>(): FrameLog<F> {
  const log = createFrameLog<F>()
  liveChannel.onEngineRestart(() => log.clear())
  return log
}
