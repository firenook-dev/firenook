// Firestore's decisions: what the security rules decided, as the
// `firestore.decisions` topic delivers it — every request the rules judged
// (reads and writes from an app's client SDK, and the data page's reads
// while View as is a user), a summary each, filtered by the engine.
//
// Only requests the rules judge appear. The Admin SDK — Cloud Functions,
// servers, `firebase-admin`, and this console when it reads "As Admin" —
// skips the rules entirely, and a database with no rules file allows
// everything without asking; neither is ever recorded. That is the first
// thing an empty list has to say.
//
// The page used to read the official Requests websocket, which the Google
// Emulator UI still reads: four clients at most, the last 256 decisions of
// the last ten minutes, filtered in the browser. The topic is the one live
// channel every tab shares, holds the newest 10,000, and the engine keeps
// the newest 2,000 re-runnable for why.

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { EvaluateAuth } from '@/api/generated/EvaluateAuth'
import type { FirestoreDecision } from '@/api/generated/FirestoreDecision'
import type { FirestoreDecisionBatch } from '@/api/generated/FirestoreDecisionBatch'
import type { FirestoreDecisionsParams } from '@/api/generated/FirestoreDecisionsParams'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { liveChannel } from '@/lib/live/channel'
import { declareTopic } from '@/lib/live/topics'
import { createInvalidator, useLiveTopic } from '@/lib/live/use-live-topic'
import { type DecisionLog, createDecisionLog } from '@/rules/decision-log'
import { FS } from '../queries'

declare module '@/lib/live/topics' {
  interface TopicMap {
    'firestore.decisions': {
      params: FirestoreDecisionsParams
      events: { decisions: FirestoreDecisionBatch }
    }
  }
}

declareTopic('firestore.decisions', 'replay')

/** Coverage moves with every decision; it is read again at most once a second. */
const COVERAGE_THROTTLE_MS = 1_000

/**
 * The topic's parameters for a narrowing: the database, a path (it and
 * everything under it), a uid exactly, denials only, one method. Absent
 * filters are left out, so equal questions are equal parameters.
 */
export function decisionParams(
  database: string,
  filters: {
    path?: string | undefined
    uid?: string | undefined
    denied?: boolean | undefined
    method?: RulesMethod | undefined
  },
): FirestoreDecisionsParams {
  const params: FirestoreDecisionsParams = { database }
  if (filters.path) params.path = filters.path
  if (filters.uid) params.uid = filters.uid
  if (filters.denied) params.denied = true
  if (filters.method) params.method = filters.method
  return params
}

/**
 * Holds `firestore.decisions` for the question `params` asks while mounted
 * (`null`: not now — diagnostics are off) and keeps the log it answers
 * with. A new question starts the log again, and so does a new engine run
 * (its ids start again). Each batch asks coverage for its report again (at
 * most once a second, and only while it is shown) and marks the draft's
 * impact stale.
 */
export function useFirestoreDecisions(
  database: string,
  params: FirestoreDecisionsParams | null,
): { log: DecisionLog<FirestoreDecision>; status: SubscriptionStatus } {
  const [log] = useState(() => createDecisionLog<FirestoreDecision>())
  const queryClient = useQueryClient()
  const [coverage] = useState(() =>
    createInvalidator(
      (key) => void queryClient.invalidateQueries({ queryKey: key }),
      COVERAGE_THROTTLE_MS,
    ),
  )
  useEffect(() => () => coverage.dispose(), [coverage])
  const question = params === null ? null : JSON.stringify(params)
  // Declared before the subscription, so the log is empty again before the
  // new question's replay can arrive (and after the old one stopped).
  useEffect(() => {
    log.answer(question)
  }, [log, question])
  useEffect(() => liveChannel.onEngineRestart(() => log.clear()), [log])
  const status = useLiveTopic('firestore.decisions', params, {
    onDecisions: (batch) => {
      log.push(batch)
      if (batch.items.length === 0) return
      coverage.push([[FS, database, 'rules-coverage']])
      void queryClient.invalidateQueries({
        queryKey: [FS, database, 'rules-impact'],
        refetchType: 'none',
      })
    },
    onReset: (_reason, missed) => {
      if (missed === null) log.clear()
      else log.gap(missed)
    },
  })
  return { log, status }
}

/**
 * A decision the engine no longer keeps the request of, as what the
 * playground can try from its summary: the operation, the path, and who
 * asked (their uid, tenant and sign-in provider). The document is read as
 * it is now.
 */
export function recordedAuth(decision: FirestoreDecision): EvaluateAuth | null {
  if (decision.anonymous || decision.uid === null) return null
  const firebase: Record<string, unknown> = {}
  if (decision.provider) firebase.sign_in_provider = decision.provider
  if (decision.tenant) firebase.tenant = decision.tenant
  return { uid: decision.uid, token: { sub: decision.uid, user_id: decision.uid, firebase } }
}

/** What an empty, unnarrowed list says. */
export function emptyText(enforced: boolean): string {
  return enforced
    ? "No rules decisions yet. Only requests your rules judge appear here: reads and writes from your app's client SDK, or from the data page while View as is a user. The Admin SDK — Cloud Functions, servers, and the console reading as admin — skips the rules, so it never shows."
    : 'This database has no rules loaded, so the emulator allows every request without checking, and nothing appears here.'
}
