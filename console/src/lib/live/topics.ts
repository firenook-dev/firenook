// The live channel's topics: what each one takes and what it says. A
// section adds its own topics from its own file (`src/<id>/live.ts`), with a
// module augmentation of `TopicMap` and one `declareTopic` call:
//
//   declare module '@/lib/live/topics' {
//     interface TopicMap {
//       'auth.users': { params: { project?: string; tenant?: string }; events: { changed: AuthUsersChanged } }
//     }
//   }
//   declareTopic('auth.users', 'none')
//
// `tick` is reserved (a cursor-only event: the channel consumes it and never
// calls a handler), and so are the channel's own `reset` and `end`.

import type { ChangeBatch } from '@/api/generated/ChangeBatch'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { RulesChanged } from '@/api/generated/RulesChanged'
import type { RulesFileStatus } from '@/api/generated/RulesFileStatus'
import type { BadgeSet, Job } from './contract'

export interface TopicMap {
  shell: { params: Record<string, never>; events: { status: ConsoleStatus; badges: BadgeSet } }
  jobs: { params: { section?: string }; events: { job: Job } }
  'firestore.changes': {
    params: { database?: string; scope?: string }
    events: { change: ChangeBatch }
  }
  'firestore.rules': {
    params: { database?: string }
    events: { rules: RulesChanged; file: RulesFileStatus }
  }
}

export type TopicName = keyof TopicMap

/** One `ev` as the engine writes it. */
export interface LiveEnvelope {
  sub: string
  name: string
  cursor: string | null
  data: unknown
}

/**
 * How a topic resumes (foundation spec §6.2 rule 5), which decides whether
 * subscribers may share one engine subscription:
 *
 * - `replay`: from a ring, by each subscriber's own cursor; never shared,
 *   because two subscribers are at two places in it;
 * - `compare`: the cursor is a state token, and every subscriber of the same
 *   parameters holds the same state, so the browser holds one engine
 *   subscription and gives a newcomer the latest event of each name;
 * - `none`: invalidation only; shared too, with nothing to give a newcomer.
 */
export type ResumeKind = 'replay' | 'compare' | 'none'

const RESUME = new Map<string, ResumeKind>([
  ['shell', 'compare'],
  ['jobs', 'replay'],
  ['firestore.changes', 'replay'],
  ['firestore.rules', 'compare'],
])

/** Declares how a section's topic resumes; see `ResumeKind`. */
export function declareTopic(topic: TopicName, resume: ResumeKind): void {
  RESUME.set(topic, resume)
}

/** A topic nobody declared is treated as `replay`: never shared, always correct. */
export function resumeOf(topic: string): ResumeKind {
  return RESUME.get(topic) ?? 'replay'
}

/**
 * The topic and its parameters as one string, keys sorted at every level and
 * `undefined` left out, so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` name one
 * subscription.
 */
export function topicKey(topic: string, params: object): string {
  return `${topic} ${canonical(params)}`
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The parameters without their `undefined` fields: what goes on the wire. */
export function wireParams(params: object): Record<string, unknown> {
  return JSON.parse(canonical(params)) as Record<string, unknown>
}
