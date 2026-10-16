// A queue re-registered because its options changed, said out loud (TK-62,
// D-T11): the official emulator replaces the queue and its pending tasks
// vanish without a word; this engine moves them to History as `replaced`,
// and the queue view says so once per registration, until dismissed.

import { Button } from '@cloudflare/kumo'
import { useState } from 'react'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import { SectionBanner } from '@/components/console/section-banner'
import { formatNumber } from '@/lib/format'
import { clockTime } from '@/lib/format'

const storageKey = (queue: TasksQueue) =>
  `firenook.console.tasks.replaced.${queue.key}.${queue.registrations}`

function dismissed(queue: TasksQueue): boolean {
  try {
    return localStorage.getItem(storageKey(queue)) !== null
  } catch {
    return false
  }
}

/** "processOrder re-registered at 10:14:03 with new options; 3 pending tasks were dropped (see History)." */
export function replacedText(queue: Pick<TasksQueue, 'id' | 'lastReplaced'>): string | undefined {
  const replaced = queue.lastReplaced
  if (!replaced) return undefined
  const dropped =
    replaced.dropped === 0
      ? 'no task was waiting'
      : `${formatNumber(replaced.dropped)} ${replaced.dropped === 1 ? 'task was' : 'tasks were'} dropped (see History)`
  return `${queue.id} re-registered at ${clockTime(replaced.at, 'second')} with new options; ${dropped}.`
}

export function ReplacedBanner({
  queue,
  onShowHistory,
}: {
  queue: TasksQueue
  onShowHistory: () => void
}) {
  // Dismissed per registration: the next re-registration says its own news.
  const id = `${queue.key}.${queue.registrations}`
  const [hidden, setHidden] = useState<{ id: string; hidden: boolean }>(() => ({
    id,
    hidden: dismissed(queue),
  }))
  let shown = hidden
  if (hidden.id !== id) {
    shown = { id, hidden: dismissed(queue) }
    setHidden(shown)
  }
  const text = replacedText(queue)
  if (!text || shown.hidden) return null
  return (
    <SectionBanner
      tone="info"
      testId="tasks-replaced-banner"
      action={
        queue.lastReplaced && queue.lastReplaced.dropped > 0 ? (
          <Button variant="secondary" size="xs" onClick={onShowHistory}>
            Show replaced
          </Button>
        ) : undefined
      }
      onDismiss={() => {
        try {
          localStorage.setItem(storageKey(queue), '1')
        } catch {
          // Without storage it stays dismissed until the page reloads.
        }
        setHidden({ id, hidden: true })
      }}
      dismissLabel="Dismiss the re-registration note"
    >
      {text}
    </SectionBanner>
  )
}
