// The rules page's conversation with the engine: checking a draft without
// installing it, evaluating requests against it, opening a recorded
// decision, asking what a draft would change, the version history, the
// coverage report, the backend the rules kit's draft runs on, and the live
// topic that says when the rules in force move.

import { queryOptions } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { API_BASE } from '@/api/client'
import type { DecisionDetail } from '@/api/generated/DecisionDetail'
import type { EvaluateRequest } from '@/api/generated/EvaluateRequest'
import type { RulesCheck } from '@/api/generated/RulesCheck'
import type { RulesCheckBody } from '@/api/generated/RulesCheckBody'
import type { RulesEvaluateBody } from '@/api/generated/RulesEvaluateBody'
import type { RulesEvaluation } from '@/api/generated/RulesEvaluation'
import type { RulesImpact } from '@/api/generated/RulesImpact'
import type { RulesImpactBody } from '@/api/generated/RulesImpactBody'
import type { RulesVersion } from '@/api/generated/RulesVersion'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { coverageQueryOptions } from '@/rules/coverage'
import type { RulesBackend } from '@/rules/draft'
import { rulesFailure } from '@/rules/text'
import { FS } from '../queries'
import { type RulesDocument, putRules, rulesQuery } from '../rules'

export type {
  DecisionDetail,
  EvaluateRequest,
  RulesCheck,
  RulesEvaluation,
  RulesImpact,
  RulesVersion,
}

/** A database's rules as the rules kit's draft reaches them; the draft is kept per database. */
export function firestoreRulesBackend(project: string, database: string) {
  return {
    draftKey: `firenook.console.rules-draft.${project}.${database}`,
    document: rulesQuery(database),
    put: (source: string, save: boolean) => putRules(database, source, save),
  } satisfies RulesBackend<RulesDocument, string[]>
}

/** The bodies the engine reads, as it declares them: a hand-built body is checked against them. */
type RulesBody = RulesCheckBody | RulesEvaluateBody | RulesImpactBody

async function post<T>(path: string, body: RulesBody, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}/firestore/${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  })
  if (!response.ok) throw await rulesFailure(response)
  return (await response.json()) as T
}

/** Compile a draft without installing it: errors, the engine's warnings, the outline and the map. */
export function checkRules(database: string, source: string, signal?: AbortSignal) {
  const body: RulesCheckBody = { database, source }
  return post<RulesCheck>('rules/check', body, signal)
}

export const checkQuery = (database: string, source: string) =>
  queryOptions({
    queryKey: [FS, database, 'rules-check', source],
    queryFn: ({ signal }) => checkRules(database, source, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/** Evaluate requests as a dry run: against a draft when one is given, else the rules in force. */
export function evaluateRules(
  database: string,
  requests: EvaluateRequest[],
  source?: string,
  signal?: AbortSignal,
) {
  const body: RulesEvaluateBody =
    source === undefined ? { database, requests } : { database, source, requests }
  return post<RulesEvaluation>('rules/evaluate', body, signal)
}

/** A recorded decision, run again with the values each expression had. */
export const decisionQuery = (database: string, requestId: string) =>
  queryOptions({
    queryKey: [FS, database, 'rules-decision', requestId],
    queryFn: async (): Promise<DecisionDetail | null> => {
      const response = await fetch(
        `${API_BASE}/firestore/rules/decisions/${encodeURIComponent(requestId)}`,
        { headers: { accept: 'application/json' } },
      )
      // Not retained any more: the list still has what the feed recorded.
      if (response.status === 404) return null
      if (!response.ok) throw await rulesFailure(response)
      return (await response.json()) as DecisionDetail
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/** Which recent decisions a draft would turn around. */
export const impactQuery = (database: string, source: string) =>
  queryOptions({
    queryKey: [FS, database, 'rules-impact', source],
    queryFn: ({ signal }) => {
      const body: RulesImpactBody = { database, source }
      return post<RulesImpact>('rules/impact', body, signal)
    },
    staleTime: 5_000,
    retry: false,
  })

export const historyQuery = (database: string) =>
  queryOptions({
    queryKey: [FS, database, 'rules-history'],
    queryFn: async (): Promise<RulesVersion[]> => {
      const response = await fetch(
        `${API_BASE}/firestore/rules/history?database=${encodeURIComponent(database)}`,
        { headers: { accept: 'application/json' } },
      )
      if (!response.ok) throw await rulesFailure(response)
      return (await response.json()) as RulesVersion[]
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/**
 * How often each rule ran: the official report, read from the console's
 * origin. Asked for again when the decisions feed grows (no timer).
 */
export const coverageQuery = (project: string, database: string) =>
  coverageQueryOptions(
    [FS, database, 'rules-coverage'],
    `${API_BASE}/firestore/emulator/v1/projects/${encodeURIComponent(project)}:ruleCoverage?database=${encodeURIComponent(database)}`,
  )

/**
 * Holds the `firestore.rules` subscription while mounted: when what governs
 * the database changes — saved elsewhere, the file edited in an editor, a
 * test suite's hot reload — the page refetches what it shows. The topic
 * tells the file's status on every subscription; it refetches only when
 * that differs from what the page holds, so opening the page costs nothing
 * more. No polling.
 */
export function useRulesLive(database: string): SubscriptionStatus {
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: rulesQuery(database).queryKey })
    void queryClient.invalidateQueries({ queryKey: [FS, database, 'rules-history'] })
    void queryClient.invalidateQueries({ queryKey: [FS, database, 'rules-coverage'] })
  }
  const shown = () => queryClient.getQueryData<RulesDocument>(rulesQuery(database).queryKey)
  return useLiveTopic(
    'firestore.rules',
    { database },
    {
      onRules: (changed) => {
        // After the page's own apply, its refetch may already hold this hash.
        if (shown()?.hash !== changed.hash)
          void queryClient.invalidateQueries({ queryKey: rulesQuery(database).queryKey })
        void queryClient.invalidateQueries({ queryKey: [FS, database, 'rules-history'] })
        void queryClient.invalidateQueries({ queryKey: [FS, database, 'rules-coverage'] })
      },
      onFile: (status) => {
        if (JSON.stringify(shown()?.fileProblems ?? null) !== JSON.stringify(status.problems))
          void queryClient.invalidateQueries({ queryKey: rulesQuery(database).queryKey })
      },
      onReset: refresh,
    },
  )
}
