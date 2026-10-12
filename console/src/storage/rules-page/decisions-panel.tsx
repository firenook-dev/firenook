// Every request Storage's rules judged, newest first, beside the rules that
// judged it: the rules kit's decisions panel (`src/rules/decisions-shell.tsx`)
// over the `storage.decisions` topic.
//
// - The filter row is the topic's parameters — a folder or a file, a uid,
//   denials only, a method — and the page's URL: a change resubscribes and
//   the engine answers, so the count is what it holds for that question.
// - A row says when, what, on which file, who asked and what an upload
//   proposed; a decision opens onto who asked, the file before and the one
//   proposed, the lines that decided it, and why, with the editor lit.
// - The footer names the window the engine holds, so an old "See why" that
//   no longer opens is explained before it is tried.

import { Button, DropdownMenu, InputGroup, Tabs } from '@cloudflare/kumo'
import { CaretDownIcon, FolderIcon, UserIcon } from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageImpactFlip } from '@/api/generated/storage/StorageImpactFlip'
import { LiveNotice } from '@/components/console/live-notice'
import { MenuCheck } from '@/components/kit'
import { formatBytes, formatClock, useClockFormat } from '@/lib/format'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { liveChannel } from '@/lib/live/channel'
import { type DecisionNarrowing, DecisionsShell } from '@/rules/decisions-shell'
import { RULES_METHODS } from '@/rules/search'
import { Verdict } from '@/rules/verdict'
import { DecisionDetail } from './decision-detail'
import {
  type DecisionLog,
  decidingLines,
  gapText,
  useDecisionLog,
  whoAsked,
  windowText,
} from './decisions'
import { FolderField } from './folder-field'
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
  const [path, setPath, commitPath] = useSettled(search.path ?? '', (next) =>
    update({ path: next || undefined, decision: undefined }, { replace: true }),
  )
  const [uid, setUid, commitUid] = useSettled(search.uid ?? '', (next) =>
    update({ uid: next || undefined, decision: undefined }, { replace: true }),
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
      filters={
        <div className="grid min-w-0 flex-1 gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <FolderField
              project={project}
              bucket={bucket}
              value={path}
              onChange={setPath}
              onCommit={commitPath}
              placeholder="Folder or file"
              ariaLabel="Decisions on a folder or a file"
              testId="decisions-path"
              icon={<FolderIcon size={14} />}
              className="min-w-0 flex-1"
            />
            <InputGroup size="sm" className="w-32 shrink-0">
              <InputGroup.Addon>
                <UserIcon size={14} />
              </InputGroup.Addon>
              <InputGroup.Input
                value={uid}
                onChange={(event) => setUid(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitUid(uid)
                }}
                placeholder="uid"
                aria-label="Decisions of a uid"
                spellCheck={false}
                autoComplete="off"
                className="font-mono placeholder:font-sans"
                data-testid="decisions-uid"
              />
            </InputGroup>
          </div>
          <div className="flex items-center gap-2">
            <Tabs
              variant="segmented"
              size="sm"
              value={search.denied ? 'denied' : 'all'}
              onValueChange={(next) =>
                update({ denied: next === 'denied', decision: undefined }, { replace: true })
              }
              tabs={[
                { value: 'all', label: 'All' },
                { value: 'denied', label: 'Denied' },
              ]}
            />
            <MethodMenu
              value={search.method}
              onChange={(method) => update({ method, decision: undefined }, { replace: true })}
            />
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() =>
                  update(
                    {
                      path: undefined,
                      uid: undefined,
                      denied: undefined,
                      method: undefined,
                      decision: undefined,
                    },
                    { replace: true },
                  )
                }
                data-testid="decisions-clear"
              >
                Clear filters
              </Button>
            )}
          </div>
        </div>
      }
      narrowed={narrowings}
      notice={
        <span className="ml-auto">
          <LiveNotice status={status} what="the decisions" onRetry={() => liveChannel.retry()} />
        </span>
      }
      empty={empty}
      gaps={gaps}
      renderGap={(missed) => <span className="truncate">{gapText(missed)}</span>}
      clock={format === 'relative' ? 'second' : 'minute'}
      renderRow={(decision, now) => (
        <DecisionRow
          decision={decision}
          bucket={scope === '*' ? undefined : bucket}
          flip={flipped.get(decision.id)}
          time={formatClock(decision.at, format, now)}
        />
      )}
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
      footer={
        diagnostics &&
        windowText(held, format) && (
          <div
            className="shrink-0 border-t border-kumo-line px-3 py-1.5 text-[11px] text-kumo-subtle"
            data-testid="decisions-window"
          >
            {windowText(held, format)}
          </div>
        )
      }
    />
  )
}

/** "Any method" or one of the five, from a menu that names them all. */
function MethodMenu({
  value,
  onChange,
}: {
  value: RulesMethod | undefined
  onChange: (method: RulesMethod | undefined) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="ghost" size="sm" data-testid="decisions-method">
            <span className={value ? 'font-mono' : ''}>{value ?? 'Any method'}</span>
            <CaretDownIcon size={12} className="text-kumo-subtle" />
          </Button>
        }
      />
      <DropdownMenu.Content align="start">
        <DropdownMenu.Item onClick={() => onChange(undefined)}>
          <MenuCheck on={value === undefined} />
          Any method
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        {RULES_METHODS.map((method) => (
          <DropdownMenu.Item
            key={method}
            onClick={() => onChange(method)}
            data-testid={`decisions-method-${method}`}
          >
            <MenuCheck on={value === method} />
            <span className="font-mono">{method}</span>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/**
 * A decision's two lines: when, the method, the path (cut from the front, so
 * the file's own name stays), the verdict; then who asked, what an upload
 * proposed, what the draft would make of it, and the deciding lines.
 */
function DecisionRow({
  decision,
  bucket,
  flip,
  time,
}: {
  decision: StorageDecision
  /** The page's bucket: a decision from another bucket names its own. */
  bucket: string | undefined
  flip: StorageImpactFlip | undefined
  time: string
}) {
  const lines = decidingLines(decision)
  const proposed = [
    decision.size === null ? undefined : formatBytes(decision.size),
    decision.contentType ?? undefined,
  ].filter(Boolean)
  return (
    <>
      <span className="flex min-w-0 items-center gap-2 text-[12px]">
        <span className="shrink-0 font-mono text-kumo-subtle tabular-nums">{time}</span>
        <span className="shrink-0 rounded bg-kumo-tint px-1 font-mono text-[11px] text-kumo-default">
          {decision.method}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-left font-mono text-kumo-default"
          dir="rtl"
          title={decision.path}
        >
          <bdi>{decision.path || '/'}</bdi>
        </span>
        <span className="shrink-0">
          <Verdict outcome={decision.outcome} />
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-kumo-subtle">
        <span className="min-w-0 truncate font-mono">{whoAsked(decision)}</span>
        {bucket === undefined || decision.bucket === bucket ? null : (
          <>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate font-mono">gs://{decision.bucket}</span>
          </>
        )}
        {proposed.length > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0 font-mono">{proposed.join(' ')}</span>
          </>
        )}
        {flip && (
          <span className="shrink-0 text-kumo-warning" data-testid="decision-flip">
            → {flip.after === 'allow' ? 'allowed' : 'denied'} by the draft
          </span>
        )}
        {lines.length > 0 && (
          <span className="ml-auto shrink-0 font-mono">
            {lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(', ')}`}
          </span>
        )}
      </span>
    </>
  )
}
