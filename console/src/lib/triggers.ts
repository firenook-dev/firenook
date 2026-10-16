// Which functions fire for a resource: the Firestore document a delete
// would remove, a Storage object, an Auth tenant, a Pub/Sub topic, an
// Eventarc type on a channel, a task queue. Every destructive confirmation
// and every trigger chip asks here, one way (foundation spec §7.14), and
// the engine answers with the one matcher the Functions runtime itself
// uses (`GET /functions/triggers`), so what a chip says is what will run.
//
// An answer is asked for once per resource and kept (`staleTime:
// Infinity`): reopening a document asks nothing. What can change it is a
// reload of a codebase, so while any answer is on screen the page holds one
// `functions.events` subscription, inventory changes only, shared by every
// caller, and a completed load invalidates every answer (and every match
// explanation). No polling.
//
// "No function listens" is said only when the engine knows it. While the
// answer is not known — Functions starting, the question not answered —
// the hook says `'unknown'`, and callers draw no trigger line at all;
// `'absent'` when the suite runs no Functions.

import { type QueryClient, type QueryKey, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiGet } from '@/api/client'
import type { EntityRef } from '@/api/generated/EntityRef'
import type { FunctionTriggersResult } from '@/api/generated/compute/FunctionTriggersResult'
import type { FunctionsLiveBatch } from '@/api/generated/compute/FunctionsLiveBatch'
import { statusQuery } from '@/api/queries'
import { type LiveChannel, liveChannel } from './live/channel'
import { createInvalidator } from './live/use-live-topic'

/** One function that would run, as the engine names it. */
export type TriggerFunction = {
  functionId: string
  codebase: string
  eventType: string
  kind: string
  /** The function in Functions (`functions.function`), so a chip links without building a ref. */
  function?: EntityRef
}

/** A service whose changes can fire a function. */
export type TriggerService = 'firestore' | 'auth' | 'storage' | 'pubsub' | 'eventarc' | 'tasks'

/**
 * The functions that would fire, with whether background triggers are
 * delivered at all; `'unknown'` while the answer is not known (Functions
 * starting, not answered yet);
 * `'absent'` when Functions are not part of the suite.
 */
export type TriggersAnswer =
  | { functions: readonly TriggerFunction[]; backgroundEnabled: boolean }
  | 'unknown'
  | 'absent'

/** One answer's query key. */
export function triggersKey(
  project: string,
  service: TriggerService,
  resource: string,
  event?: string,
): QueryKey {
  return ['functions', project, 'triggers', service, resource, event ?? null]
}

/** What a completed load makes stale: every answer here, and every match explanation. */
export function reloadKeys(project: string): readonly QueryKey[] {
  return [
    ['functions', project, 'triggers'],
    ['functions', project, 'match'],
  ]
}

/** Asks the engine who fires for a resource; an empty or absent `event` means every kind. */
export function fetchTriggers(
  service: TriggerService,
  resource: string,
  event: string | undefined,
  signal?: AbortSignal,
): Promise<FunctionTriggersResult> {
  return apiGet<FunctionTriggersResult>(
    '/functions/triggers',
    { service, resource, event: event === '' ? undefined : event },
    signal,
  )
}

interface Watch {
  holders: number
  stop: () => void
}

/** The inventory watch each query client holds, per project, while anyone asks. */
const watches = new WeakMap<QueryClient, Map<string, Watch>>()

/**
 * Holds the one `functions.events` subscription (inventory changes only)
 * that keeps every answer current, for as long as one caller holds it; the
 * returned function lets go. A completed load — even one that changed no
 * definition, since a reload can change who fires — invalidates the
 * answers, with the live hooks' leading and trailing edge, so a burst of
 * saves asks once or twice, not once per save. A `reset` (missed changes)
 * or the topic ending invalidates them at once.
 */
export function holdInventoryWatch(
  client: QueryClient,
  project: string,
  channel: LiveChannel = liveChannel,
): () => void {
  let byProject = watches.get(client)
  if (!byProject) {
    byProject = new Map()
    watches.set(client, byProject)
  }
  let watch = byProject.get(project)
  if (!watch) {
    const keys = reloadKeys(project)
    const invalidator = createInvalidator(
      (key) => void client.invalidateQueries({ queryKey: key }),
      120,
    )
    const unsubscribe = channel.subscribe(
      'functions.events',
      { changesOnly: true },
      {
        onEvent(name, data) {
          if (name !== 'batch') return
          const batch = data as FunctionsLiveBatch
          if (batch.changes.some((change) => change.kind === 'inventory')) invalidator.push(keys)
        },
        onReset() {
          invalidator.flush(keys)
        },
        onEnd() {
          invalidator.flush(keys)
        },
      },
    )
    watch = {
      holders: 0,
      stop: () => {
        unsubscribe()
        invalidator.dispose()
      },
    }
    byProject.set(project, watch)
  }
  watch.holders += 1
  const held = watch
  const map = byProject
  let released = false
  return () => {
    if (released) return
    released = true
    held.holders -= 1
    if (held.holders > 0) return
    held.stop()
    if (map.get(project) === held) map.delete(project)
  }
}

/**
 * Which functions fire for this resource, in the engine's formats:
 *
 * | service | resource |
 * | --- | --- |
 * | `firestore` | `<database>\|<document path>` (`(default)\|orders/o_1`) |
 * | `storage` | `<bucket>\|<object name>` |
 * | `auth` | the tenant id, or `''` for the project's users |
 * | `pubsub` | the topic's full name, `projects/<project>/topics/<topic>` |
 * | `eventarc` | `<channel>\|<event type>` (the channel's full name, or `google`) |
 * | `tasks` | the queue key, `queue:<project>-<location>-<queue>` |
 *
 * `event` narrows the answer to one change or event kind (`created`,
 * `deleted`, `finalized`, `create`, `beforeCreate`…); absent means every
 * kind. `resource: undefined` asks nothing (`'unknown'`).
 */
export function useTriggersFor(
  service: TriggerService,
  resource: string | undefined,
  event?: string,
): TriggersAnswer {
  const client = useQueryClient()
  const status = useQuery(statusQuery)
  const project = status.data?.projectId ?? ''
  const entry = status.data?.sections.find((section) => section.id === 'functions')
  const asking = entry?.state === 'ready' && resource !== undefined
  const answer = useQuery({
    queryKey: triggersKey(project, service, resource ?? '', event),
    queryFn: ({ signal }) => fetchTriggers(service, resource ?? '', event, signal),
    enabled: asking,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  useEffect(() => {
    if (!asking) return undefined
    return holdInventoryWatch(client, project)
  }, [asking, client, project])
  if (entry?.state === 'absent') return 'absent'
  if (!asking || !answer.data) return 'unknown'
  return {
    functions: answer.data.functions,
    // The shell's status is live; the answer is from when it was asked.
    backgroundEnabled: status.data?.backgroundTriggers.enabled ?? answer.data.backgroundEnabled,
  }
}
