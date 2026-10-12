// What the Tasks emulator turned down, said where it matters (TK-01a,
// TK-01, D-T1, D-T10): an enqueue the Tasks port refused — a queue in
// another region or project, a reused name, a full queue — with where the
// queue really is; and an `onTaskDispatched` the emulator would not
// register, with its reason. At most three strips, then how many more.

import { Button } from '@cloudflare/kumo'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import type { TasksRefused } from '@/api/generated/messaging/TasksRefused'
import type { TasksRejectedQueue } from '@/api/generated/messaging/TasksRejectedQueue'
import { SectionBanner } from '@/components/console/section-banner'
import { formatNumber } from '@/lib/format'

/** Strips shown before "and n more". */
const SHOWN = 3

/** One refusal in a sentence: what, where, how often, the answer verbatim, and where the queue is. */
export function refusedText(refused: TasksRefused): string {
  const verb = refused.operation === 'delete' ? 'Delete in' : 'Enqueue into'
  const times = refused.count === 1 ? 'once' : `${formatNumber(refused.count)} times`
  const where = `${refused.location}/${refused.queue}`
  const said = refused.error.trim().replace(/[.\s]+$/, '')
  const suggestion = refused.suggestion ? ` ${refused.suggestion.replace(/[.\s]*$/, '.')}` : ''
  return `${verb} ${where} refused ${times} with ${refused.status} “${said}”.${suggestion}`
}

/** The registered queue a refusal most likely meant: the same id in another location or project. */
export function meantQueue(
  refused: TasksRefused,
  queues: readonly TasksQueue[],
): TasksQueue | undefined {
  return queues.find(
    (queue) =>
      queue.id === refused.queue &&
      (queue.location !== refused.location || queue.project !== refused.project),
  )
}

const NONE: readonly TasksRejectedQueue[] = []

export function RefusedBanners({
  refused,
  rejected = NONE,
  queues,
  current,
  onOpen,
}: {
  refused: readonly TasksRefused[]
  rejected?: readonly TasksRejectedQueue[]
  queues: readonly TasksQueue[]
  /** The queue on screen: no button to open what is already open. */
  current?: string | undefined
  onOpen: (queue: TasksQueue) => void
}) {
  const strips = [
    ...refused.map((entry, index) => ({ kind: 'refused' as const, entry, index })),
    ...rejected.map((entry) => ({ kind: 'rejected' as const, entry })),
  ]
  if (strips.length === 0) return null
  const shown = strips.slice(0, SHOWN)
  const more = strips.length - shown.length
  return (
    <div className="grid shrink-0" data-testid="tasks-refusals">
      {shown.map((strip) => {
        if (strip.kind === 'rejected') {
          const entry = strip.entry
          return (
            <SectionBanner
              key={`rejected:${entry.functionId}`}
              tone="warning"
              testId="tasks-rejected-banner"
            >
              <span className="font-mono text-[0.9em]">{entry.name}</span> ({entry.region}) was not
              registered as a queue: {entry.reason.replace(/[.\s]*$/, '.')}
            </SectionBanner>
          )
        }
        const entry = strip.entry
        const meant = meantQueue(entry, queues)
        return (
          <SectionBanner
            // Refusals are coalesced by operation, queue and status, but the
            // project can differ: the engine's place in its list tells two apart.
            key={`refused:${entry.project}/${entry.location}/${entry.queue}:${entry.operation}:${entry.status}:${strip.index}`}
            tone="warning"
            testId="tasks-refused-banner"
            action={
              meant && meant.key !== current ? (
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => onOpen(meant)}
                  data-testid="tasks-refused-open"
                >
                  Open {meant.location}/{meant.id}
                </Button>
              ) : undefined
            }
          >
            {refusedText(entry)}
          </SectionBanner>
        )
      })}
      {more > 0 && (
        <SectionBanner tone="warning" testId="tasks-refused-more">
          and {formatNumber(more)} more {more === 1 ? 'refusal' : 'refusals'}: the Queues panel
          lists them all.
        </SectionBanner>
      )}
    </div>
  )
}
