// Every decision the rules made, newest first, beside the rules that made
// them: Firestore's adapter of the rules kit's decisions panel
// (`src/rules/decisions-shell.tsx`). It was the Requests drawer at the foot
// of the data page: a "Live" chip that only repeated the normal case, an
// empty state that never said why it was empty, a row that opened onto raw
// JSON with the whole rules file in it as one escaped string, and a filter
// that did nothing at the root. Now:
//
// - the feed speaks only when it is unavailable;
// - an empty list says what appears here and what never does — the
//   Admin SDK and the console as admin skip the rules;
// - a decision opens onto who asked, what the document was and would
//   be, and the lines that decided it, each a way into the editor;
// - narrowing is by path, user, verdict and operation, and from the URL, so
//   a denied read on the data page links straight to the decision behind
//   it.
//
// The Requests feed cannot be asked to narrow (its JSON is pinned by the
// official emulator's conformance fixtures), so this adapter narrows in the
// browser; Storage's asks the engine.

import { Badge, Tooltip } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { ImpactFlip } from '@/api/generated/ImpactFlip'
import { formatClock, formatNumber } from '@/lib/format'
import { type DecisionNarrowing, DecisionsShell } from '@/rules/decisions-shell'
import { rulesQuery } from '../rules'
import { DecisionDetail } from './decision-detail'
import {
  DECISIONS_KEPT,
  type RulesDecision,
  decidingLines,
  filterDecisions,
  useDecisions,
} from './decisions'
import { useRulesSearch } from './rules-search'

export function DecisionsPanel({
  database,
  source,
  flips,
  selected,
  onReveal,
}: {
  database: string
  /** The text in the editor, which a decision is drawn into only when it decided by it. */
  source: string
  /** The decisions the draft would turn around, while there is a draft that compiles. */
  flips: readonly ImpactFlip[] | undefined
  selected: RulesDecision | undefined
  onReveal: (line: number) => void
}) {
  const { search, update } = useRulesSearch()
  const status = useDecisions((state) => state.status)
  const detail = useDecisions((state) => state.detail)
  const all = useDecisions((state) => state.decisions)
  const clear = useDecisions((state) => state.clear)
  const rules = useQuery(rulesQuery(database))
  const [text, setText] = useState('')

  const flipped = new Map((flips ?? []).map((flip) => [flip.requestId, flip]))
  const narrowed = filterDecisions(all, database, {
    path: search.path,
    uid: search.uid,
    denied: search.denied,
    method: search.method,
    text,
  })
  const shown = search.flips
    ? narrowed.filter((decision) => flipped.has(decision.requestId))
    : narrowed

  const narrowings: DecisionNarrowing[] = [
    ...(search.flips
      ? [
          {
            label: 'Would change',
            value: 'if the draft is applied',
            onRemove: () => update({ flips: undefined }),
          },
        ]
      : []),
    ...(search.path
      ? [{ label: 'Path', value: search.path, onRemove: () => update({ path: undefined }) }]
      : []),
    ...(search.uid !== undefined
      ? [
          {
            label: 'User',
            value: search.uid || 'anonymous',
            onRemove: () => update({ uid: undefined }),
          },
        ]
      : []),
    ...(search.method
      ? [{ label: 'Method', value: search.method, onRemove: () => update({ method: undefined }) }]
      : []),
  ]

  return (
    <DecisionsShell
      items={shown}
      itemKey={(decision) => decision.requestId}
      isDenied={(decision) => decision.outcome !== 'allow'}
      selected={selected}
      onOpen={(decision) => update({ decision: decision?.requestId })}
      onStep={(decision) => update({ decision: decision.requestId }, { replace: true })}
      pick={search.pick}
      onPick={(decision) =>
        update({ decision: decision.requestId, pick: undefined }, { replace: true })
      }
      filter={{ value: text, onChange: setText, placeholder: 'Filter by path, user or method' }}
      denied={search.denied ?? false}
      onDenied={(denied) => update({ denied })}
      onClearList={all.length > 0 ? clear : undefined}
      narrowed={narrowings}
      notice={<FeedNotice status={status} detail={detail} />}
      empty={emptyMessage({
        status,
        detail,
        filtered: all.some((decision) => decision.database === database),
        enforced: rules.data?.enforced ?? true,
      })}
      row={(decision) => ({
        outcome: decision.outcome,
        method: decision.method,
        path: decision.path,
        at: decision.time,
        who: decision.uid ?? 'anonymous',
        flip: flipped.get(decision.requestId)?.after,
        lines: decidingLines(decision),
      })}
      held={heldText(all.filter((decision) => decision.database === database))}
      renderDetail={(decision) => (
        <DecisionDetail
          key={decision.requestId}
          decision={decision}
          database={database}
          sameRules={decision.rules === source}
          onReveal={onReveal}
        />
      )}
    />
  )
}

/** The feed's state, said only when something is wrong with it. */
function FeedNotice({ status, detail }: { status: string; detail: string | undefined }) {
  if (status === 'unavailable')
    return (
      <Tooltip
        content={detail ?? 'The decisions feed is unavailable'}
        render={
          <span className="ml-auto">
            <Badge variant="error" appearance="dot">
              Unavailable
            </Badge>
          </span>
        }
      />
    )
  if (status === 'reconnecting')
    return (
      <Tooltip
        content="The decisions feed closed. It reconnects by itself, and lists what it missed once."
        render={
          <span className="ml-auto" data-testid="decisions-reconnecting">
            <Badge variant="warning" appearance="dot">
              Reconnecting
            </Badge>
          </span>
        }
      />
    )
  return null
}

/** What an empty list says: why it is empty, and what never appears here. */
function emptyMessage({
  status,
  detail,
  filtered,
  enforced,
}: {
  status: string
  detail: string | undefined
  filtered: boolean
  enforced: boolean
}): string {
  if (status === 'unavailable') return detail ?? 'The decisions feed is unavailable on this engine.'
  if (status === 'reconnecting') return 'Reconnecting to the decisions feed…'
  if (status !== 'live') return 'Connecting…'
  if (filtered) return 'No decisions match.'
  if (!enforced)
    return 'This database has no rules loaded, so the emulator allows every request without checking, and nothing appears here.'
  return "No decisions in the last ten minutes. Only requests your rules judge appear here: reads and writes from your app's client SDK, or from the data page while View as is a user. The Admin SDK — Cloud Functions, servers, and the console reading as admin — skips the rules, so it never shows."
}

/**
 * The footer under the list, as Storage's says what its engine holds:
 * "Holding the last 12 decisions, since 09:12:04 · this tab keeps the newest 500".
 */
export function heldText(
  decisions: readonly Pick<RulesDecision, 'time'>[],
  now = Date.now(),
): string | undefined {
  const oldest = decisions.at(-1)
  if (!oldest) return undefined
  const count = decisions.length
  return `Holding the last ${formatNumber(count)} ${count === 1 ? 'decision' : 'decisions'}, since ${formatClock(oldest.time, 'time', now)} · this tab keeps the newest ${formatNumber(DECISIONS_KEPT)}`
}
