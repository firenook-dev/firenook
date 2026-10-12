// Every request Storage's rules judged, newest first, beside the rules that
// judged it: the rules kit's decisions panel (`src/rules/decisions-shell.tsx`)
// over the `storage.decisions` topic — the same panel as Firestore's.
//
// - The filter field takes the topic's parameters as terms — a folder or a
//   file, `uid:<uid>`, a method — beside All or Denied, and they are the
//   page's URL: a change resubscribes and the engine answers, so the count
//   is what it holds for that question.
// - A row says the verdict, the method and the file; then when, who asked,
//   what an upload proposed and the deciding lines. A decision opens onto
//   who asked, the file before and the one proposed, the lines that decided
//   it, and why, with the editor lit.
// - The footer names the window the engine holds, so an old "See why" that
//   no longer opens is explained before it is tried.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageImpactFlip } from '@/api/generated/storage/StorageImpactFlip'
import { LiveNotice } from '@/components/console/live-notice'
import { formatBytes, useClockFormat } from '@/lib/format'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { liveChannel } from '@/lib/live/channel'
import { type DecisionNarrowing, DecisionsShell } from '@/rules/decisions-shell'
import { DecisionDetail } from './decision-detail'
import {
  type DecisionLog,
  decidingLines,
  gapText,
  parseDecisionFilter,
  printDecisionFilter,
  useDecisionLog,
  whoAsked,
  windowText,
} from './decisions'
import { useStorageRulesSearch } from './rules-search'

/** How long typing in a filter must pause before the question changes. */
const SETTLE_MS = 350

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

export function DecisionsPanel({
  project,
  scope,
  bucket,
  diagnostics,
  enforced,
  log,
  status,
  flips,
  rulesOf,
  editorSource,
  onReveal,
}: {
  project: string
  scope: string
  /** The bucket the filters complete folders in (the page's). */
  bucket: string
  /** Whether the engine records decisions at all. */
  diagnostics: boolean
  /** Whether any rules govern the scope. */
  enforced: boolean
  log: DecisionLog
  status: SubscriptionStatus
  /** The decisions the draft would turn around, while there is a draft that compiles. */
  flips: readonly StorageImpactFlip[] | undefined
  rulesOf: (hash: string) => string | undefined
  editorSource: string
  onReveal: (line: number) => void
}) {
  const { search, update } = useStorageRulesSearch()
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
  // so a replay on its way never flashes it.
  // Each question waits again: a narrowing's replay is on its way too.
  const question = JSON.stringify([search.path, search.uid, search.denied, search.method])
  const [waitedFor, setWaitedFor] = useState<string | undefined>()
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setWaitedFor(question), 400)
    return () => globalThis.clearTimeout(timer)
  }, [question])
  const waited = waitedFor === question

  const flipped = new Map((flips ?? []).map((flip) => [flip.id, flip]))
  const shown = search.flips ? items.filter((item) => flipped.has(item.id)) : items
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

  const empty = !diagnostics
    ? 'Rules decisions are off: the suite was started with --no-diagnostics.'
    : !heard && !waited
      ? 'Reading the decisions the engine holds…'
      : search.flips
        ? 'Applying the draft would change none of the decisions listed.'
        : filtered
          ? 'No decisions match. Loosen a filter, or make the request from your app.'
          : !enforced
            ? 'No rules govern this bucket, so every client request is refused before the rules can judge it. Apply rules to see decisions here.'
            : 'No rules decisions yet. Admin, the console as Admin and downloads with a valid token skip the rules, so only client requests appear here.'

  return (
    <DecisionsShell<StorageDecision>
      items={diagnostics ? shown : []}
      itemKey={(decision) => decision.id}
      isDenied={(decision) => decision.outcome !== 'allow'}
      selected={selected}
      onOpen={(decision) => update({ decision: decision?.id })}
      onStep={(decision) => update({ decision: decision.id }, { replace: true })}
      pick={search.pick}
      onPick={(decision) => update({ decision: decision.id, pick: undefined }, { replace: true })}
      filter={{
        value: terms,
        onChange: setTerms,
        onCommit: commitTerms,
        placeholder: 'Filter by path, uid:<uid> or method',
      }}
      denied={search.denied ?? false}
      onDenied={(denied) => update({ denied, decision: undefined }, { replace: true })}
      onClearList={() => log.clear()}
      narrowed={narrowings}
      notice={
        <span className="ml-auto">
          <LiveNotice status={status} what="the decisions" onRetry={() => liveChannel.retry()} />
        </span>
      }
      empty={empty}
      gaps={gaps}
      renderGap={(missed) => <span className="truncate">{gapText(missed)}</span>}
      row={(decision) => ({
        outcome: decision.outcome,
        method: decision.method,
        path: decision.path,
        keepEnd: true,
        at: decision.at,
        who: whoAsked(decision),
        extras: rowExtras(decision, scope === '*' ? undefined : bucket),
        flip: flipped.get(decision.id)?.after,
        lines: decidingLines(decision),
      })}
      renderDetail={(decision) => (
        <DecisionDetail
          key={decision.id}
          project={project}
          scope={scope}
          decision={decision}
          rulesOf={rulesOf}
          editorSource={editorSource}
          onReveal={onReveal}
          onTry={() => update({ panel: 'playground' })}
        />
      )}
      held={diagnostics ? windowText(held, format) : undefined}
    />
  )
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
