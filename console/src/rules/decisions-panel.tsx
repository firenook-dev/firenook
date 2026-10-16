// Every decision a rules page's topic delivers, newest first, beside the
// rules that made them: the decisions shell (`decisions-shell.tsx`) filled
// from a page's decision log, the same on Firestore's page and Storage's.
//
// - The filter field takes the topic's parameters as terms — a path,
//   `uid:<uid>`, a method — beside All or Denied, and they are the page's
//   URL: a change resubscribes and the engine answers, so the count is
//   what it holds for that question.
// - A row says the verdict, the method and the path; then when, who asked,
//   what else the page knows and the deciding lines. A decision opens onto
//   the page's detail.
// - The footer names the window the engine holds, so an old "See why" that
//   no longer opens is explained before it is tried.

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import { LiveNotice } from '@/components/console/live-notice'
import { useClockFormat } from '@/lib/format'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { liveChannel } from '@/lib/live/channel'
import {
  type DecisionLog,
  type RulesDecisionSummary,
  decidingLines,
  gapText,
  parseDecisionFilter,
  printDecisionFilter,
  useDecisionLog,
  whoAsked,
  windowText,
} from './decision-log'
import { type DecisionNarrowing, DecisionsShell } from './decisions-shell'

/** How long typing in a filter must pause before the question changes. */
const SETTLE_MS = 350

/** The part of a rules page's address the decisions panel reads and writes. */
export interface DecisionsSearch {
  decision?: string | undefined
  path?: string | undefined
  uid?: string | undefined
  denied?: boolean | undefined
  method?: RulesMethod | undefined
  flips?: boolean | undefined
  pick?: boolean | undefined
}

/** A filter field's text, written to the address once typing settles (or at once on Enter). */
function useSettled(
  value: string,
  commit: (value: string) => void,
): [string, (next: string) => void, (next: string) => void] {
  const [text, setText] = useState(value)
  const [seen, setSeen] = useState(value)
  // The address changed by itself (a link, Back): the field follows it.
  if (value !== seen) {
    setSeen(value)
    setText(value)
  }
  // The latest commit, read when the timer fires: decisions arriving while
  // the person types re-render the panel, and must not restart the wait.
  const latest = useRef(commit)
  useLayoutEffect(() => {
    latest.current = commit
  })
  useEffect(() => {
    if (text === value) return
    const timer = globalThis.setTimeout(() => latest.current(text), SETTLE_MS)
    return () => globalThis.clearTimeout(timer)
  }, [text, value])
  return [
    text,
    setText,
    (next) => {
      setText(next)
      if (next !== value) latest.current(next)
    },
  ]
}

export function RulesDecisionsPanel<T extends RulesDecisionSummary>({
  search,
  update,
  diagnostics,
  log,
  status,
  flips,
  placeholder,
  empty,
  keepEnd = false,
  extras,
  renderDetail,
}: {
  search: DecisionsSearch
  update: (patch: DecisionsSearch, options?: { replace?: boolean }) => void
  /** Whether the engine records decisions at all. */
  diagnostics: boolean
  log: DecisionLog<T>
  status: SubscriptionStatus
  /** What the draft would turn each decision into, while there is a draft that compiles. */
  flips: ReadonlyMap<string, RulesOutcome> | undefined
  /** Says which terms the field takes: "Filter by path, uid:<uid> or method". */
  placeholder: string
  /** What an empty list says when nothing narrows it: nothing governs the scope, or nothing yet. */
  empty: string
  /** Cut a long path from its start, so a file's own name stays (Storage's). */
  keepEnd?: boolean
  /** What else a row says about a decision beyond who asked. */
  extras?: ((decision: T) => string[]) | undefined
  renderDetail: (decision: T) => ReactNode
}) {
  const items = useDecisionLog(log, (state) => state.items)
  const gaps = useDecisionLog(log, (state) => state.gaps)
  const held = useDecisionLog(log, (state) => state.window)
  const heard = useDecisionLog(log, (state) => state.heard)
  const { format } = useClockFormat()
  // One field, the URL's three terms: a path, `uid:`, a method.
  const [terms, setTerms, commitTerms] = useSettled(
    printDecisionFilter({ path: search.path, uid: search.uid, method: search.method }),
    (next) => {
      const parsed = parseDecisionFilter(next)
      update(
        { path: parsed.path, uid: parsed.uid, method: parsed.method, decision: undefined },
        { replace: true },
      )
    },
  )
  // A quiet engine sends nothing on subscribing; "none yet" waits a moment
  // so a replay on its way never flashes it. Each question waits again: a
  // narrowing's replay is on its way too.
  const question = JSON.stringify([search.path, search.uid, search.denied, search.method])
  const [waitedFor, setWaitedFor] = useState<string | undefined>()
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setWaitedFor(question), 400)
    return () => globalThis.clearTimeout(timer)
  }, [question])
  const waited = waitedFor === question

  const shown = search.flips ? items.filter((item) => flips?.has(item.id)) : items
  const selected = search.decision ? items.find((item) => item.id === search.decision) : undefined
  const filtered = Boolean(search.path || search.uid || search.denied || search.method)

  const narrowings: DecisionNarrowing[] = search.flips
    ? [
        {
          label: 'Would change',
          value: 'if the draft is applied',
          onRemove: () => update({ flips: undefined }),
        },
      ]
    : []

  const said = !diagnostics
    ? 'Rules decisions are off: the suite was started with --no-diagnostics.'
    : !heard && !waited
      ? 'Reading the decisions the engine holds…'
      : search.flips
        ? 'Applying the draft would change none of the decisions listed.'
        : filtered
          ? 'No decisions match. Loosen a filter, or make the request from your app.'
          : empty

  return (
    <DecisionsShell<T>
      items={diagnostics ? shown : []}
      itemKey={(decision) => decision.id}
      isDenied={(decision) => decision.outcome !== 'allow'}
      selected={selected}
      onOpen={(decision) => update({ decision: decision?.id })}
      onStep={(decision) => update({ decision: decision.id }, { replace: true })}
      pick={search.pick}
      onPick={(decision) => update({ decision: decision.id, pick: undefined }, { replace: true })}
      filter={{ value: terms, onChange: setTerms, onCommit: commitTerms, placeholder }}
      denied={search.denied ?? false}
      onDenied={(denied) => update({ denied, decision: undefined }, { replace: true })}
      onClearList={() => log.clear()}
      narrowed={narrowings}
      notice={
        <span className="ml-auto">
          <LiveNotice status={status} what="the decisions" onRetry={() => liveChannel.retry()} />
        </span>
      }
      empty={said}
      gaps={gaps}
      renderGap={(missed) => <span className="truncate">{gapText(missed)}</span>}
      row={(decision) => ({
        outcome: decision.outcome,
        method: decision.method,
        path: decision.path,
        keepEnd,
        at: decision.at,
        who: whoAsked(decision),
        extras: extras?.(decision),
        flip: flips?.get(decision.id),
        lines: decidingLines(decision),
      })}
      renderDetail={renderDetail}
      held={diagnostics ? windowText(held, format) : undefined}
    />
  )
}
