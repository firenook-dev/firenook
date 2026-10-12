// One `tasks.queue` subscription per open queue (messaging spec §6.3), and
// the views that read it: the Tasks table patches its rows from the row
// keys, History refreshes its head from the finished ids, and both go back
// to page one on a reset. The queue view holds the subscription; whichever
// list is on screen listens, so switching tabs never opens a second one.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TasksFinishedBatch } from '@/api/generated/messaging/TasksFinishedBatch'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { useQueueLive } from './live'

export interface QueueListener {
  rows?: (keys: string[]) => void
  finished?: (batch: TasksFinishedBatch) => void
  reset?: () => void
  /** The engine took the subscription: a list read before it reads again. */
  taken?: () => void
}

interface QueueHub {
  listen: (listener: QueueListener) => () => void
}

export const QueueLiveContext = createContext<QueueHub | null>(null)

/** Holds `tasks.queue` for the queue and hands each event to the views listening. */
export function useQueueHub(
  project: string | undefined,
  queue: string | undefined,
): { status: SubscriptionStatus; hub: QueueHub } {
  const listeners = useRef(new Set<QueueListener>())
  const status = useQueueLive(project, queue, {
    onRowKeys: (keys) => {
      for (const listener of listeners.current) listener.rows?.(keys)
    },
    onFinished: (batch) => {
      for (const listener of listeners.current) listener.finished?.(batch)
    },
    onReset: () => {
      for (const listener of listeners.current) listener.reset?.()
    },
    onTaken: () => {
      for (const listener of listeners.current) listener.taken?.()
    },
  })
  const [hub] = useState<QueueHub>(() => ({
    listen: (listener) => {
      listeners.current.add(listener)
      return () => {
        listeners.current.delete(listener)
      }
    },
  }))
  return { status, hub }
}

/** Listens to the open queue's events while mounted; handlers are read through a ref. */
export function useQueueListener(handlers: QueueListener): void {
  const hub = useContext(QueueLiveContext)
  const latest = useRef(handlers)
  useLayoutEffect(() => {
    latest.current = handlers
  })
  useEffect(
    () =>
      hub?.listen({
        rows: (keys) => latest.current.rows?.(keys),
        finished: (batch) => latest.current.finished?.(batch),
        reset: () => latest.current.reset?.(),
        taken: () => latest.current.taken?.(),
      }),
    [hub],
  )
}
