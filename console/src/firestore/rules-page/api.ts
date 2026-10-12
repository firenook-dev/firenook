// The rules page's conversation with the engine: checking a draft without
// installing it, evaluating requests against it, opening a recorded
// decision, asking what a draft would change, the version history, and the
// live topic that says when the rules in force move.

import { queryOptions } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { API_BASE, ApiError } from '@/api/client'
import type { DecisionDetail } from '@/api/generated/DecisionDetail'
import type { EvaluateRequest } from '@/api/generated/EvaluateRequest'
import type { RulesCheck } from '@/api/generated/RulesCheck'
import type { RulesEvaluation } from '@/api/generated/RulesEvaluation'
import type { RulesImpact } from '@/api/generated/RulesImpact'
import type { RulesVersion } from '@/api/generated/RulesVersion'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { FS } from '../queries'
import { RulesCompileError, type RulesDiagnostic, type RulesDocument, rulesQuery } from '../rules'

export type {
  DecisionDetail,
  EvaluateRequest,
  RulesCheck,
  RulesEvaluation,
  RulesImpact,
  RulesVersion,
}

async function failure(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`
  let diagnostics: RulesDiagnostic[] = []
  try {
    const body = (await response.json()) as {
      error?: { message?: string }
      diagnostics?: RulesDiagnostic[]
    }
    if (body.error?.message) message = body.error.message
    if (body.diagnostics) diagnostics = body.diagnostics
  } catch {
    // Keep the status line.
  }
  return diagnostics.length > 0
    ? new RulesCompileError(message, diagnostics)
    : new ApiError(response.status, message)
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}/firestore/${path}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as T
}

/** Compile a draft without installing it: errors, the engine's warnings, the outline and the map. */
export function checkRules(database: string, source: string, signal?: AbortSignal) {
  return post<RulesCheck>('rules/check', { database, source }, signal)
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
  return post<RulesEvaluation>(
    'rules/evaluate',
    source === undefined ? { database, requests } : { database, source, requests },
    signal,
  )
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
      if (!response.ok) throw await failure(response)
      return (await response.json()) as DecisionDetail
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

/** Which recent decisions a draft would turn around. */
export const impactQuery = (database: string, source: string) =>
  queryOptions({
    queryKey: [FS, database, 'rules-impact', source],
    queryFn: ({ signal }) => post<RulesImpact>('rules/impact', { database, source }, signal),
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
      if (!response.ok) throw await failure(response)
      return (await response.json()) as RulesVersion[]
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

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
