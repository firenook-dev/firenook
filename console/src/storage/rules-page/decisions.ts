// Storage's decisions: what the Storage rules decided, as the
// `storage.decisions` topic delivers it, kept in the rules kit's decision
// log (`src/rules/decision-log.ts`) — the same log, panel and words as
// Firestore's page. Every filter is the topic's parameters — a folder or a
// file, a uid, denials only, a method — which the engine evaluates on the
// replay and on the live tail, and the same values are the page's URL.

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageDecisionsParams } from '@/api/generated/storage/StorageDecisionsParams'
import { formatBytes } from '@/lib/format'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { liveChannel } from '@/lib/live/channel'
import { type DecisionLog, createDecisionLog } from '@/rules/decision-log'
import { useStorageDecisionsLive } from '../live'
import { storageKeys } from '../queries'

/** How the panel narrows the decisions, as the URL holds it. */
export interface DecisionFilters {
  path?: string | undefined
  uid?: string | undefined
  denied?: boolean | undefined
  method?: RulesMethod | undefined
}

/**
 * The topic's parameters for a narrowing: the scope's bucket (none when one
 * ruleset governs every bucket, which then lists every bucket's decisions),
 * a path as typed (a value ending in `/`, or empty, is a folder), a uid
 * exactly, denials only, one method. Absent filters are left out, so equal
 * questions are equal parameters.
 */
export function decisionParams(
  bucket: string | undefined,
  filters: DecisionFilters,
): StorageDecisionsParams {
  const params: StorageDecisionsParams = {}
  if (bucket !== undefined) params.bucket = bucket
  if (filters.path) params.path = filters.path
  if (filters.uid) params.uid = filters.uid
  if (filters.denied) params.denied = true
  if (filters.method) params.method = filters.method
  return params
}

/**
 * Holds `storage.decisions` for the question `params` asks while mounted
 * (`null`: not now — decisions are off, or the panel is not shown) and keeps
 * the log it answers with. A new question starts the log again, and so does
 * a new engine run (its ids start again).
 */
export function useStorageDecisions(
  project: string,
  scope: string,
  params: StorageDecisionsParams | null,
): { log: DecisionLog<StorageDecision>; status: SubscriptionStatus } {
  const [log] = useState(() => createDecisionLog<StorageDecision>())
  const queryClient = useQueryClient()
  const question = params === null ? null : JSON.stringify(params)
  // Declared before the subscription, so the log is empty again before the
  // new question's replay can arrive (and after the old one stopped).
  useEffect(() => {
    log.answer(question)
  }, [log, question])
  useEffect(() => liveChannel.onEngineRestart(() => log.clear()), [log])
  const status = useStorageDecisionsLive(project, scope, params, {
    onDecisions: (batch) => log.push(batch),
    onReset: (_reason, missed) => {
      if (missed === null) log.clear()
      else log.gap(missed)
      void queryClient.invalidateQueries({ queryKey: storageKeys.rulesImpactOf(project, scope) })
    },
  })
  return { log, status }
}

/**
 * What else a row says about a decision beyond who asked: the bucket when
 * it is not the page's, and what an upload proposed (its size and type).
 */
export function rowExtras(
  decision: Pick<StorageDecision, 'bucket' | 'size' | 'contentType'>,
  bucket: string | undefined,
): string[] {
  const extras: string[] = []
  if (bucket !== undefined && decision.bucket !== bucket) extras.push(`gs://${decision.bucket}`)
  const proposed = [
    decision.size === null ? undefined : formatBytes(decision.size),
    decision.contentType ?? undefined,
  ].filter(Boolean)
  if (proposed.length > 0) extras.push(proposed.join(' '))
  return extras
}

/** What an empty, unnarrowed list says. */
export function emptyText(enforced: boolean): string {
  return enforced
    ? 'No rules decisions yet. Admin, the console as Admin and downloads with a valid token skip the rules, so only client requests appear here.'
    : 'No rules govern this bucket, so every client request is refused before the rules can judge it. Apply rules to see decisions here.'
}
