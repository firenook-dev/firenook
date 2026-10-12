// Changes to many users at once, as the engine's jobs make them
// (`POST /auth/users:<verb>`): the ticked rows by key, or every user the
// filter matches when "Select all N matching" is on — the filter text and
// the list's scope, evaluated by the engine when the job runs, so 48,213
// uids never travel. A query target, or more than 50 keys, asks the engine
// first (a dry run) so the confirmation states real numbers; a small
// selection starts at once. The engine applies a change in chunks of
// 2,000 users, so the app's own requests are never held up.

import type { AuthBulkPreview } from '@/api/generated/auth/AuthBulkPreview'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import { formatCount, formatNumber } from '@/lib/format'
import type { BulkVerb } from './api'
import { type TenantScope, keysTarget, queryTarget } from './tenant-scope'

/** Past this many ticked users a change asks the engine for its numbers first. */
export const DRY_RUN_OVER = 50
/** A delete that runs `user.delete` triggers is refused above this many users. */
export const TRIGGERED_DELETE_LIMIT = 10_000
/** Past this many users a delete asks for the number to be typed. */
export const TYPE_TO_CONFIRM_OVER = 100

const USERS = { one: 'user', other: 'users' }

/** The selection as a job's target: the ticked uids, or the filter when every match is selected. */
export function bulkTarget(
  scope: TenantScope,
  selection: { checked: ReadonlySet<string>; everything: boolean },
  q: string,
): BulkTarget {
  return selection.everything ? queryTarget(scope, q) : keysTarget(scope, [...selection.checked])
}

/** Whether the engine is asked for the real numbers before the job starts. */
export function needsDryRun(target: BulkTarget): boolean {
  return target.by === 'query' || target.keys.length > DRY_RUN_OVER
}

/** The verbs a selection offers besides delete and claims, as their buttons and jobs say them. */
export const SIMPLE_VERBS = ['disable', 'enable', 'verify', 'revoke'] as const
export type SimpleVerb = (typeof SIMPLE_VERBS)[number]

interface VerbWords {
  /** The button: "Disable". */
  button: string
  /** What was done, for the toast: "Disabled 3 users". */
  doneTitle: (count: number) => string
  /** The confirm's title and the job's: "Disable 1,204 users". */
  title: (count: number) => string
  /** What a done item is: "disabled". */
  done: string
  /** What `unchanged` means for this verb: "already disabled". */
  already: string
  /** One line of what the change does. */
  explains: string
}

export const VERB_WORDS: Readonly<
  Record<SimpleVerb | 'setClaims' | 'removeClaims' | 'delete', VerbWords>
> = {
  disable: {
    button: 'Disable',
    doneTitle: (count) => `Disabled ${formatCount(count, USERS)}`,
    title: (count) => `Disable ${formatCount(count, USERS)}`,
    done: 'disabled',
    already: 'already disabled',
    explains:
      'They cannot sign in or refresh a token; ID tokens they hold keep working until they expire.',
  },
  enable: {
    button: 'Enable',
    doneTitle: (count) => `Enabled ${formatCount(count, USERS)}`,
    title: (count) => `Enable ${formatCount(count, USERS)}`,
    done: 'enabled',
    already: 'already enabled',
    explains: 'They can sign in again.',
  },
  verify: {
    button: 'Verify email',
    doneTitle: (count) => `Marked ${formatCount(count, USERS)} as verified`,
    title: (count) => `Mark ${formatCount(count, USERS)} as verified`,
    done: 'verified',
    already: 'already verified or without an email',
    explains: 'Their email counts as verified, as after following a verification link.',
  },
  revoke: {
    button: 'Revoke',
    doneTitle: (count) => `Revoked the tokens of ${formatCount(count, USERS)}`,
    title: (count) => `Revoke the tokens of ${formatCount(count, USERS)}`,
    done: 'revoked',
    already: 'unchanged',
    explains:
      'ID tokens issued before now fail verifyIdToken(token, true) and the emulator’s own checks; as in the official emulator, refresh tokens still mint new ID tokens.',
  },
  setClaims: {
    button: 'Claims…',
    doneTitle: (count) => `Set claims on ${formatCount(count, USERS)}`,
    title: (count) => `Set claims on ${formatCount(count, USERS)}`,
    done: 'changed',
    already: 'already had these claims',
    explains: 'Signed-in clients see new claims after their ID token refreshes.',
  },
  removeClaims: {
    button: 'Remove claim keys',
    doneTitle: (count) => `Removed claim keys from ${formatCount(count, USERS)}`,
    title: (count) => `Remove claim keys from ${formatCount(count, USERS)}`,
    done: 'changed',
    already: 'did not have them',
    explains: 'The keys are removed from each user’s claims.',
  },
  delete: {
    button: 'Delete',
    doneTitle: (count) => `Deleted ${formatCount(count, USERS)}`,
    title: (count) => `Delete ${formatCount(count, USERS)}`,
    done: 'deleted',
    already: 'already gone',
    explains: 'Re-import an export to get them back.',
  },
}

/** "Disable 1,204 users? 3 are already disabled." from the dry run. */
export function previewSentence(verb: keyof typeof VERB_WORDS, preview: AuthBulkPreview): string {
  const words = VERB_WORDS[verb]
  const base = `${words.title(preview.matched)}?`
  if (preview.unchanged === 0) return base
  return `${base} ${formatNumber(preview.unchanged)} ${preview.unchanged === 1 ? 'is' : 'are'} ${words.already}.`
}

/**
 * Whether a delete may be offered without triggers — the emulator's own
 * delete-all semantics: every user of the scope (no filter), or the sample
 * users. For sample users it is the default, since their import fired none.
 */
export function withoutTriggersOffer(target: BulkTarget): 'off' | 'offered' | 'default' {
  if (target.by !== 'query') return 'off'
  const q = target.q.trim()
  if (q === '') return 'offered'
  if (q === 'is:sample') return 'default'
  return 'off'
}

/** Why a delete cannot start: a triggered delete of more than 10,000 users. */
export function deleteRefusal(count: number, triggers: boolean): string | undefined {
  if (!triggers || count <= TRIGGERED_DELETE_LIMIT) return undefined
  return 'A delete that runs your user.delete triggers is limited to 10,000 users per action. Narrow the filter, or delete in several steps: each user queues one event for your Functions.'
}

/** The engine's verbs for the job kinds Auth starts. */
export const JOB_VERBS: Readonly<Record<BulkVerb, string>> = {
  disable: 'disabled',
  enable: 'enabled',
  verify: 'verified',
  revoke: 'revoked',
  setClaims: 'changed',
  removeClaims: 'changed',
  delete: 'deleted',
}
