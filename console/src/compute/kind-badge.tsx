// How a function is triggered, as one quiet chip: the official functions
// shell's word for it (`http`, `firestore`, `tasks`…) in the data face,
// the same ground for every kind. The word already names the kind, so a
// colour per kind would say it twice and spend the colour the outcome and
// problem marks need (the `TypeBadge` rule). Functions' lists and the
// Extensions Functions tab draw it; it lives here because both do.

import { Tooltip, cn } from '@cloudflare/kumo'
import type { FunctionKind } from '@/api/generated/compute/FunctionKind'

/** Every kind, in the order the console lists them. */
export const KIND_WORDS: readonly FunctionKind[] = [
  'http',
  'callable',
  'firestore',
  'storage',
  'auth',
  'pubsub',
  'schedule',
  'eventarc',
  'tasks',
  'blocking',
  'alerts',
  'database',
  'other',
]

/** What each kind is, for the chip's tooltip: what makes such a function run. */
export const KIND_HELP: Readonly<Record<FunctionKind, string>> = {
  http: 'Runs on an HTTPS request to its URL (onRequest).',
  callable: 'Called from an app through the Functions SDK (onCall).',
  firestore: 'Runs when a Firestore document is written.',
  storage: 'Runs when a Storage object changes.',
  auth: 'Runs when an Authentication user is created or deleted.',
  pubsub: 'Runs for each message published to its Pub/Sub topic.',
  schedule: 'Runs on a schedule, through a Pub/Sub topic (onSchedule).',
  eventarc: 'Runs for custom events published on an Eventarc channel.',
  tasks: 'Runs for each task in its Cloud Tasks queue (onTaskDispatched).',
  blocking: 'Decides an Authentication sign-up or sign-in before it completes.',
  alerts: 'Runs for Firebase Alerts.',
  database: 'Runs when Realtime Database data changes.',
  other: 'A trigger the console has no word for.',
}

/** The chip's classes: `TypeBadge`'s, going a step darker with a lit row so it keeps its ground. */
export const KIND_CHIP =
  'flex h-4.5 w-fit shrink-0 items-center rounded bg-kumo-tint px-1 font-mono text-[11px] leading-none text-kumo-subtle group-hover:ink group-data-[selected]:ink'

export function KindBadge({
  kind,
  tooltip = true,
  className,
}: {
  kind: FunctionKind
  /** Off where the kind is explained beside it already. */
  tooltip?: boolean | undefined
  className?: string | undefined
}) {
  const chip = (
    <span className={cn(KIND_CHIP, className)} data-testid="kind-badge" data-kind={kind}>
      {kind}
    </span>
  )
  if (!tooltip) return chip
  return <Tooltip content={KIND_HELP[kind]} render={chip} />
}
