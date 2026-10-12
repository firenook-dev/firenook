// Every decision the rules made, newest first, beside the rules that made
// them. It was the Requests drawer at the foot of the data page: a
// "Live" chip that only repeated the normal case, an empty state that
// never said why it was empty, a row that opened onto raw JSON with the
// whole rules file in it as one escaped string, and a filter that did
// nothing at the root. Now:
//
// - the feed speaks only when it is unavailable;
// - an empty list says what appears here and what never does — the
//   Admin SDK and the console as admin skip the rules;
// - a decision opens onto who asked, what the document was and would
//   be, and the lines that decided it, each a way into the editor;
// - narrowing is by path, user and verdict, and from the URL, so a denied
//   read on the data page links straight to the decision behind it.

import { Badge, Button, InputGroup, Tabs, Text, Tooltip } from '@cloudflare/kumo'
import {
  ArrowLeftIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { rulesQuery } from '../rules'
import { useNow } from '@/lib/clock'
import { relativeTime } from '@/lib/format'
import { DecisionDetail } from './decision-detail'
import {
  type DecisionOutcome,
  type RulesDecision,
  decidingLines,
  filterDecisions,
  useDecisions,
} from './decisions'
import type { ImpactFlip } from '@/api/generated/ImpactFlip'
import { useRulesSearch } from './rules-search'

const ROW = 44

/** A decision's verdict as the list writes it: a dot and a word. */
export function Verdict({ outcome }: { outcome: DecisionOutcome }) {
  const word = outcome === 'allow' ? 'allowed' : outcome === 'deny' ? 'denied' : 'error'
  const tone =
    outcome === 'allow'
      ? 'bg-kumo-success'
      : outcome === 'deny'
        ? 'bg-kumo-danger'
        : 'bg-kumo-warning'
  const text =
    outcome === 'allow'
      ? 'text-kumo-subtle'
      : outcome === 'deny'
        ? 'text-kumo-danger'
        : 'text-kumo-warning'
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 text-[12px] ${text}`}
      data-outcome={outcome}
    >
      <span className={`size-1.5 rounded-full ${tone}`} aria-hidden />
      {word}
    </span>
  )
}

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
  // The console's shared minute clock, so "just now" does not stay just now.
  const now = useNow('minute')

  const flipped = new Map((flips ?? []).map((flip) => [flip.requestId, flip]))
  const narrowed = filterDecisions(all, database, {
    path: search.path,
    uid: search.uid,
    denied: search.denied,
    text,
  })
  const shown = search.flips
    ? narrowed.filter((decision) => flipped.has(decision.requestId))
    : narrowed
  const denied = shown.filter((decision) => decision.outcome !== 'allow').length

  // "See why" from the data page names a path and a user and asks for the
  // newest denial that matches — once. Going back to the list afterwards
  // is going back to the list.
  useEffect(() => {
    if (!search.pick) return
    const match = shown.find((decision) => decision.outcome !== 'allow')
    if (match) update({ decision: match.requestId, pick: undefined }, { replace: true })
  }, [search.pick, shown, update])

  if (selected) {
    const index = shown.findIndex((decision) => decision.requestId === selected.requestId)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-kumo-line px-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeftIcon />}
            onClick={() => update({ decision: undefined })}
            data-testid="decision-back"
          >
            All decisions
          </Button>
          <span className="ml-auto flex items-center gap-0.5">
            <Text as="span" variant="secondary" size="xs">
              {index >= 0 ? `${index + 1} of ${shown.length}` : ''}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CaretLeftIcon />}
              aria-label="Newer decision"
              disabled={index <= 0}
              onClick={() => {
                const next = shown[index - 1]
                if (next) update({ decision: next.requestId }, { replace: true })
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CaretRightIcon />}
              aria-label="Older decision"
              disabled={index < 0 || index >= shown.length - 1}
              onClick={() => {
                const next = shown[index + 1]
                if (next) update({ decision: next.requestId }, { replace: true })
              }}
            />
          </span>
        </div>
        <DecisionDetail
          key={selected.requestId}
          decision={selected}
          database={database}
          sameRules={selected.rules === source}
          onReveal={onReveal}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="decisions">
      <div className="grid shrink-0 gap-2 border-b border-kumo-line px-3 py-2">
        <div className="flex items-center gap-2">
          <InputGroup size="sm" className="min-w-0 flex-1">
            <InputGroup.Addon>
              <MagnifyingGlassIcon size={14} />
            </InputGroup.Addon>
            <InputGroup.Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Filter by path, user or method"
              aria-label="Filter decisions"
              spellCheck={false}
              autoComplete="off"
              data-testid="decisions-filter"
            />
          </InputGroup>
          <Tabs
            variant="segmented"
            size="sm"
            value={search.denied ? 'denied' : 'all'}
            onValueChange={(next) => update({ denied: next === 'denied' })}
            tabs={[
              { value: 'all', label: 'All' },
              { value: 'denied', label: 'Denied' },
            ]}
          />
          <Tooltip
            content="Clear the list in this tab"
            render={
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<TrashIcon />}
                aria-label="Clear the list"
                onClick={clear}
                disabled={all.length === 0}
              />
            }
          />
        </div>
        {(search.path || search.uid !== undefined || search.flips) && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="decisions-narrowed">
            {search.flips && (
              <Chip
                label="Would change"
                value="if the draft is applied"
                onRemove={() => update({ flips: undefined })}
              />
            )}
            {search.path && (
              <Chip label="Path" value={search.path} onRemove={() => update({ path: undefined })} />
            )}
            {search.uid !== undefined && (
              <Chip
                label="User"
                value={search.uid || 'anonymous'}
                onRemove={() => update({ uid: undefined })}
              />
            )}
          </div>
        )}
        <div className="flex items-center gap-2 text-[12px] text-kumo-subtle">
          <span data-testid="decisions-count">
            <span className="tabular-nums">{shown.length}</span>{' '}
            {shown.length === 1 ? 'decision' : 'decisions'}
            {denied > 0 && (
              <>
                {' '}
                · <span className="text-kumo-danger tabular-nums">{denied} denied</span>
              </>
            )}
          </span>
          {status === 'unavailable' && (
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
          )}
          {status === 'reconnecting' && (
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
          )}
        </div>
      </div>
      {shown.length === 0 ? (
        <EmptyDecisions
          status={status}
          detail={detail}
          filtered={all.some((decision) => decision.database === database)}
          enforced={rules.data?.enforced ?? true}
        />
      ) : (
        <DecisionList
          decisions={shown}
          flipped={flipped}
          now={now}
          onOpen={(decision) => update({ decision: decision.requestId })}
        />
      )}
    </div>
  )
}

function Chip({ label, value, onRemove }: { label: string; value: string; onRemove: () => void }) {
  return (
    <span className="flex h-6 max-w-full items-center gap-1 rounded-md bg-kumo-tint pr-0.5 pl-2 text-[12px]">
      <span className="text-kumo-subtle">{label}</span>
      <span className="min-w-0 truncate font-mono">{value}</span>
      <Button
        variant="ghost"
        size="xs"
        shape="square"
        icon={<XIcon />}
        aria-label={`Stop narrowing by ${label.toLowerCase()}`}
        onClick={onRemove}
      />
    </span>
  )
}

function EmptyDecisions({
  status,
  detail,
  filtered,
  enforced,
}: {
  status: string
  detail: string | undefined
  filtered: boolean
  enforced: boolean
}) {
  let message: string
  if (status === 'unavailable')
    message = detail ?? 'The decisions feed is unavailable on this engine.'
  else if (status === 'reconnecting') message = 'Reconnecting to the decisions feed…'
  else if (status !== 'live') message = 'Connecting…'
  else if (filtered) message = 'No decisions match.'
  else if (!enforced)
    message =
      'This database has no rules loaded, so the emulator allows every request without checking, and nothing appears here.'
  else
    message =
      "No decisions in the last ten minutes. Only requests your rules judge appear here: reads and writes from your app's client SDK, or from the data page while View as is a user. The Admin SDK — Cloud Functions, servers, and the console reading as admin — skips the rules, so it never shows."
  return (
    <div className="p-4" data-testid="decisions-empty">
      <Text variant="secondary" size="sm">
        {message}
      </Text>
    </div>
  )
}

function DecisionList({
  decisions,
  flipped,
  now,
  onOpen,
}: {
  decisions: RulesDecision[]
  flipped: ReadonlyMap<string, ImpactFlip>
  now: number
  onOpen: (decision: RulesDecision) => void
}) {
  'use no memo'
  const scroller = useRef<HTMLDivElement>(null)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const rows = useVirtualizer({
    count: decisions.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 8,
    getItemKey: (index) => decisions[index]?.requestId ?? index,
  })
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" data-testid="decision-list">
      <ul className="relative" style={{ height: rows.getTotalSize() }}>
        {rows.getVirtualItems().map((row) => {
          const decision = decisions[row.index]
          if (!decision) return null
          const lines = decidingLines(decision)
          return (
            <li
              key={row.key}
              className="absolute inset-x-0"
              style={{ top: row.start, height: ROW }}
            >
              <button
                type="button"
                onClick={() => onOpen(decision)}
                className="grid h-full w-full content-center gap-0.5 border-b border-kumo-hairline px-3 text-left hover:ink"
                data-testid="decision-row"
                data-request-id={decision.requestId}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Verdict outcome={decision.outcome} />
                  <span className="shrink-0 font-mono text-[12px] text-kumo-subtle">
                    {decision.method}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[12px] text-kumo-default">
                    {decision.path || '/'}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-kumo-subtle">
                  <span className="shrink-0 tabular-nums">{relativeTime(decision.time, now)}</span>
                  <span aria-hidden>·</span>
                  <span className="min-w-0 truncate font-mono">{decision.uid ?? 'anonymous'}</span>
                  {flipped.has(decision.requestId) && (
                    <span className="shrink-0 text-kumo-warning" data-testid="decision-flip">
                      → {flipped.get(decision.requestId)?.after === 'allow' ? 'allowed' : 'denied'}{' '}
                      by the draft
                    </span>
                  )}
                  {lines.length > 0 && (
                    <span className="ml-auto shrink-0 font-mono">
                      {lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(', ')}`}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
