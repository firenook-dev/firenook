// Subscriptions for components: `useLiveTopic` holds one while mounted and
// hands each event to a typed handler; `useInvalidateOn` is the common case,
// where every event names query keys to refresh.

import { type QueryKey, hashKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ApiErrorDetail } from '@/api/generated/ApiErrorDetail'
import type { ResetReason } from '@/api/generated/live/ResetReason'
import {
  type LiveChannel,
  type SubscribeOptions,
  type SubscriptionState,
  type SubscriptionStatus,
  type TopicListener,
  liveChannel,
  useLiveStatus,
} from './channel'
import { type TopicMap, type TopicName, topicKey } from './topics'

type EventHandlers<K extends TopicName> = {
  [E in keyof TopicMap[K]['events'] & string as `on${Capitalize<E>}`]?: (
    data: TopicMap[K]['events'][E],
    cursor: string | undefined,
  ) => void
}

export type Handlers<K extends TopicName> = EventHandlers<K> & {
  onReset?: (reason: ResetReason, missed: number | null) => void
  onEnd?: (error: ApiErrorDetail | undefined) => void
}

/** `change` → `onChange`. */
function handlerName(event: string): string {
  return `on${event.charAt(0).toUpperCase()}${event.slice(1)}`
}

/**
 * The subscription under both hooks: subscribes while `params` is not null,
 * again when the topic or parameters change (by value, not identity), and
 * answers this subscription's status. `start` is read when a subscription
 * begins; changing it alone never resubscribes (the channel keeps the
 * cursors it is sent from then on).
 */
function useSubscription(
  topic: string,
  params: object | null,
  listener: { readonly current: Omit<TopicListener, 'onState'> },
  channel: LiveChannel,
  start?: SubscribeOptions,
): SubscriptionStatus {
  const key = params === null ? null : topicKey(topic, params)
  const [own, setOwn] = useState<{ key: string | null; state: SubscriptionState }>({
    key: null,
    state: 'pending',
  })
  const begin = useRef(start)
  useLayoutEffect(() => {
    begin.current = start
  })
  useEffect(() => {
    if (key === null) return undefined
    // The parameters as the key holds them: equal by value is the same
    // subscription, whatever object the caller built this render.
    const wire = JSON.parse(key.slice(topic.length + 1)) as Record<string, unknown>
    return channel.subscribe(
      topic,
      wire,
      {
        onEvent: (name, data, cursor) => listener.current.onEvent(name, data, cursor),
        onReset: (reason, missed) => listener.current.onReset(reason, missed),
        onEnd: (error) => listener.current.onEnd(error),
        onRefused: (error) => listener.current.onRefused?.(error),
        onState: (state) => setOwn({ key, state }),
      },
      begin.current?.after ? { after: begin.current.after } : undefined,
    )
  }, [channel, topic, key, listener])
  const status = useLiveStatus((state) => state.status)
  if (key === null) return status
  const state = own.key === key ? own.state : 'pending'
  return state === 'ended' || state === 'refused' ? state : status
}

/**
 * Holds a subscription while mounted. `params: null` means not now. Handlers are read through a ref.
 * `start.after` resumes a new subscription after a feed position the page already read: a list's
 * `liveAfter`, so a feed page that loaded its first page is not sent the whole ring again, or a
 * snapshot's `liveCursor` (pass `params: null` until the snapshot is here), so the topic picks up
 * exactly where the snapshot ends.
 */
export function useLiveTopic<K extends TopicName>(
  topic: K,
  params: NoInfer<TopicMap[K]['params']> | null,
  handlers: NoInfer<Handlers<K>>,
  channel: LiveChannel = liveChannel,
  start?: SubscribeOptions,
): SubscriptionStatus {
  const latest = useRef(handlers)
  useLayoutEffect(() => {
    latest.current = handlers
  })
  const listener = useRef<Omit<TopicListener, 'onState'>>({
    onEvent(name, data, cursor) {
      const handler = (latest.current as Record<string, unknown>)[handlerName(name)]
      if (typeof handler === 'function')
        (handler as (data: unknown, cursor: string | undefined) => void)(data, cursor)
    },
    onReset(reason, missed) {
      latest.current.onReset?.(reason, missed)
    },
    onEnd(error) {
      latest.current.onEnd?.(error)
    },
  })
  return useSubscription(topic, params, listener, channel, start)
}

/**
 * Invalidates query keys with a leading and a trailing edge, per key: the
 * first time a key is named it is invalidated at once; named again within
 * `delayMs` it is invalidated once more when that window ends, and the
 * window starts again. A sustained burst therefore refreshes about once per
 * window and always once after the last event, never once per event.
 */
export function createInvalidator(invalidate: (key: QueryKey) => void, delayMs: number) {
  const windows = new Map<
    string,
    { key: QueryKey; again: boolean; timer: ReturnType<typeof setTimeout> }
  >()
  const open = (hash: string, key: QueryKey) => {
    const timer = setTimeout(() => {
      const window = windows.get(hash)
      if (!window?.again) {
        windows.delete(hash)
        return
      }
      invalidate(window.key)
      open(hash, window.key)
    }, delayMs)
    windows.set(hash, { key, again: false, timer })
  }
  return {
    push(keys: readonly QueryKey[]) {
      const seen = new Set<string>()
      for (const key of keys) {
        const hash = hashKey(key)
        if (seen.has(hash)) continue
        seen.add(hash)
        const window = windows.get(hash)
        if (window) {
          window.again = true
          continue
        }
        invalidate(key)
        open(hash, key)
      }
    },
    /** Every key at once, now (a reset); open windows are closed. */
    flush(keys: readonly QueryKey[]) {
      for (const window of windows.values()) clearTimeout(window.timer)
      windows.clear()
      const seen = new Set<string>()
      for (const key of keys) {
        const hash = hashKey(key)
        if (seen.has(hash)) continue
        seen.add(hash)
        invalidate(key)
      }
    },
    dispose() {
      for (const window of windows.values()) clearTimeout(window.timer)
      windows.clear()
    },
  }
}

/** The common case: every event names query keys to invalidate, deduplicated, with a leading and a
 *  trailing edge: the first event invalidates at once, then at most once per key per `delayMs`
 *  (120 ms), and always once after the last event, so a sustained burst still refreshes. */
export function useInvalidateOn<K extends TopicName>(
  topic: K,
  params: NoInfer<TopicMap[K]['params']> | null,
  options: {
    keys: (name: keyof TopicMap[K]['events'] & string, data: unknown) => readonly QueryKey[]
    /** Invalidated on `reset`, on `end`, and on an engine restart. */
    resetKeys: readonly QueryKey[]
    delayMs?: number
  },
  channel: LiveChannel = liveChannel,
): SubscriptionStatus {
  const queryClient = useQueryClient()
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })
  const delayMs = options.delayMs ?? 120
  const [invalidator] = useState(() =>
    createInvalidator((key) => void queryClient.invalidateQueries({ queryKey: key }), delayMs),
  )
  useEffect(() => () => invalidator.dispose(), [invalidator])
  // The channel already invalidates every query on an engine restart.
  const listener = useRef<Omit<TopicListener, 'onState'>>({
    onEvent(name, data) {
      invalidator.push(latest.current.keys(name as keyof TopicMap[K]['events'] & string, data))
    },
    onReset() {
      invalidator.flush(latest.current.resetKeys)
    },
    onEnd() {
      invalidator.flush(latest.current.resetKeys)
    },
  })
  return useSubscription(topic, params, listener, channel)
}
