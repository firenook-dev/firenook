// What Cloud Tasks adds to ⌘K while its page is on screen (messaging spec
// §4.8): every queue of the project to open (by the same `tasks.queue` ref
// the engine's search answers with, so ⌘K shows each once), and for the
// queue in view what acts on it — Enqueue, Pause or Resume, Purge, Hold
// scheduled tasks, and its tabs.

import {
  ClockCounterClockwiseIcon,
  ClockIcon,
  GearSixIcon,
  LightningIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  QueueIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useEffect } from 'react'
import type { TasksQueue } from '@/api/generated/messaging/TasksQueue'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { queueLabel } from './queue-address'

export interface QueueCommands {
  enqueue: () => void
  pause: (paused: boolean) => void
  purge: () => void
  hold: (hold: boolean) => void
  view: (view: 'tasks' | 'attempts' | 'history' | 'config') => void
}

/** The groups for `query`: the queue in view's commands, then every queue to open. */
export function tasksPaletteGroups(options: {
  queues: readonly TasksQueue[]
  queue: TasksQueue | undefined
  commands: QueueCommands | undefined
  open: (queue: TasksQueue) => void
  query: string
}): PaletteGroup[] {
  const { queues, queue, commands, open, query } = options
  const groups: PaletteGroup[] = []
  if (queue && commands) {
    const id = queue.id
    const items: PaletteItem[] = [
      {
        id: 'tasks.enqueue-here',
        title: `Enqueue a task in ${id}`,
        icon: <PlusIcon size={16} />,
        run: commands.enqueue,
      },
      queue.paused
        ? {
            id: 'tasks.resume',
            title: `Resume ${id}`,
            icon: <PlayIcon size={16} />,
            run: () => commands.pause(false),
          }
        : {
            id: 'tasks.pause',
            title: `Pause ${id}`,
            icon: <PauseIcon size={16} />,
            run: () => commands.pause(true),
          },
      {
        id: 'tasks.purge',
        title: `Purge ${id}…`,
        icon: <TrashIcon size={16} />,
        run: commands.purge,
      },
      queue.holdScheduled
        ? {
            id: 'tasks.unhold',
            title: `Stop holding scheduled tasks in ${id}`,
            icon: <ClockIcon size={16} />,
            run: () => commands.hold(false),
          }
        : {
            id: 'tasks.hold',
            title: `Hold scheduled tasks in ${id}`,
            keywords: 'scheduleTime delay',
            icon: <ClockIcon size={16} />,
            run: () => commands.hold(true),
          },
      {
        id: 'tasks.view-attempts',
        title: `${id}: attempts`,
        icon: <LightningIcon size={16} />,
        run: () => commands.view('attempts'),
      },
      {
        id: 'tasks.view-history',
        title: `${id}: history`,
        icon: <ClockCounterClockwiseIcon size={16} />,
        run: () => commands.view('history'),
      },
      {
        id: 'tasks.view-config',
        title: `${id}: configuration`,
        keywords: 'retryConfig rateLimits maxAttempts',
        icon: <GearSixIcon size={16} />,
        run: () => commands.view('config'),
      },
    ]
    const shown = items.filter((item) => matchesQuery(item, query))
    if (shown.length > 0) groups.push({ label: id, items: shown })
  }
  const others = queues
    .filter((candidate) => candidate.key !== queue?.key)
    .map((candidate): PaletteItem => ({
      id: `tasks.queue:${candidate.key}`,
      title: queueLabel(queues, candidate),
      description: candidate.function ? `→ ${candidate.function.name}` : 'registered by a client',
      keywords: 'queue cloud tasks',
      icon: <QueueIcon size={16} />,
      run: () => open(candidate),
      ref: {
        kind: 'tasks.queue',
        key: `${candidate.project}|${candidate.location}|${candidate.id}`,
      },
    }))
    .filter((item) => matchesQuery(item, query))
  if (others.length > 0) groups.push({ label: 'Task queues', items: others })
  return groups
}

/**
 * Registers ⌘K rows while mounted, under `key`: the page registers its
 * queues, the queue view its commands, each under its own key so neither
 * replaces the other.
 */
export function useTasksPalette(options: {
  queues: readonly TasksQueue[]
  queue: TasksQueue | undefined
  commands: QueueCommands | undefined
  open: (queue: TasksQueue) => void
  key: 'tasks' | 'tasks.queue'
}): void {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  const { queues, queue, commands, open, key } = options
  useEffect(() => {
    register(key, (query) => tasksPaletteGroups({ queues, queue, commands, open, query }))
    return () => unregister(key)
  }, [register, unregister, queues, queue, commands, open, key])
}
