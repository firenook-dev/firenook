// One rules decision, opened, on either rules page: who asked, the lines
// that decided it, and why — the engine runs the recorded request again
// against the rules that decided it and says the value every expression
// had — and then what the page knows of what it was about (a document
// before and after, a file and the upload it proposed). A decision older
// than the engine's re-runnable window keeps its verdict and lines from
// the feed, and the playground takes the request from what the feed
// recorded. Its lines are drawn into the editor while it holds the rules
// that decided it.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, FlaskIcon } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect } from 'react'
import { EntityLink } from '@/components/console/entity-link'
import { formatClock, useClockFormat } from '@/lib/format'
import type { SectionLink } from '@/lib/services'
import { EVICTED, type RulesDecisionSummary, decidingLines } from './decision-log'
import { DetailSection as Section, Mono, RuleLines, Term, countLines } from './decision-parts'
import { inlineSteps } from './explain'
import { type ExplainedResult, ExplanationView } from './explanation-view'
import { linesFromAllows, useOverlay } from './overlay'
import { Verdict } from './verdict'

/** ID-token claims every Firebase token carries; anything else is the app's own. */
const STANDARD_CLAIMS = new Set([
  'iss',
  'aud',
  'auth_time',
  'user_id',
  'sub',
  'iat',
  'exp',
  'email',
  'email_verified',
  'phone_number',
  'name',
  'picture',
  'firebase',
])

function claimText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** What a decision's re-run answers with, whichever service decided it. */
export interface DecisionRerun {
  /** The source that decided it; positions refer to this text. */
  rules: string
  result: ExplainedResult
  /** The token's claims, as `request.auth.token` saw them. */
  claims: Record<string, unknown>
}

export function DecisionDetailFrame<T extends RulesDecisionSummary>({
  decision,
  scope,
  rerun,
  rerunPending,
  rerunError,
  rulesOf,
  editorSource,
  onReveal,
  onTry,
  open,
  wrong,
  noRule,
  readFunctions,
  changedSince,
  children,
}: {
  decision: T
  /** A quiet line under the path: the bucket, or the database. */
  scope?: ReactNode
  /** The decision run again, once the engine has answered; null once it keeps it no longer. */
  rerun: DecisionRerun | null | undefined
  rerunPending: boolean
  rerunError: Error | null
  /** The text of the rules that decided it, when the page still has it (in force or in history). */
  rulesOf: (hash: string) => string | undefined
  /** The text in the editor: lines can be revealed only while it holds the deciding rules. */
  editorSource: string
  onReveal: (line: number) => void
  /** Put the request in the playground and show it there. */
  onTry: () => void
  /** Where what it was about opens: "Open in Data", "Open in Files". */
  open?: { label: string; link: SectionLink | null | undefined; testId: string } | undefined
  /** What went wrong beyond a denial: the evaluator's error, a bucket no rules govern. */
  wrong?: string | undefined
  /** Why no rule ran, when none did. */
  noRule: string
  /** How the rules language spells its two document reads (Storage's are `firestore.get()`). */
  readFunctions?: readonly [string, string] | undefined
  /** Why a re-run can decide otherwise now: the documents its rules read changed. */
  changedSince: string
  /** What the page knows of what it was about: documents, files, a query. */
  children?: ReactNode
}) {
  const show = useOverlay((state) => state.show)
  const clear = useOverlay((state) => state.clear)
  const { format } = useClockFormat()
  const navigate = useNavigate()
  const rules = rerun?.rules ?? rulesOf(decision.rulesHash)
  const sameRules = rules !== undefined && rules === editorSource
  const deciding = decidingLines(decision)
  const first = deciding[0] ?? decision.allows[0]?.line

  // Drawn into the editor, over the rules that decided it: the lines it went
  // through, toned by whether they decided it, and every value it had.
  useEffect(() => {
    if (rules === undefined) return
    show({
      owner: 'decision',
      source: rules,
      lineMarks: linesFromAllows(decision.allows, decision.outcome),
      values: rerun ? inlineSteps(rerun.result.explanation, rules) : [],
      reveal: first,
    })
  }, [decision, rerun, rules, first, show])
  useEffect(() => () => clear('decision'), [clear])

  const claims = rerun?.claims ?? {}
  const custom = Object.entries(claims).filter(([key]) => !STANDARD_CLAIMS.has(key))
  const email = typeof claims.email === 'string' ? claims.email : undefined
  const link = open?.link

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="decision-detail">
      <div className="grid gap-1 border-b border-kumo-line px-3 py-3">
        <div className="flex items-center gap-2">
          <Verdict outcome={decision.outcome} />
          <span className="font-mono text-[12px] text-kumo-subtle">{decision.method}</span>
          {decision.viaConsole && (
            <span className="text-[11px] text-kumo-subtle">from the console</span>
          )}
          <Tooltip
            content={decision.at}
            render={
              <span className="ml-auto font-mono text-[12px] text-kumo-subtle tabular-nums">
                {formatClock(decision.at, format)}
              </span>
            }
          />
        </div>
        <span
          className="font-mono text-[13px] break-all text-kumo-default"
          data-testid="decision-path"
        >
          {decision.path || '/'}
        </span>
        {scope && <span className="font-mono text-[11px] text-kumo-subtle">{scope}</span>}
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            icon={<FlaskIcon />}
            onClick={onTry}
            data-testid="decision-try"
          >
            Try in the playground
          </Button>
          {open && link && (
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowSquareOutIcon />}
              onClick={() => void navigate({ to: link.to, search: link.search } as never)}
              data-testid={open.testId}
            >
              {open.label}
            </Button>
          )}
        </span>
      </div>

      {wrong && (
        <Section title="What went wrong">
          <Text size="sm" variant="error">
            {wrong}
          </Text>
        </Section>
      )}

      <Section title="Who asked" testId="decision-who">
        {decision.uid === null ? (
          <Text size="sm">{decision.anonymous ? 'Not signed in' : 'A token without a uid'}</Text>
        ) : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
            <Term>uid</Term>
            <dd className="min-w-0">
              <EntityLink
                entity={{
                  kind: 'auth.user',
                  key: `${decision.tenant ?? ''}|${decision.uid}`,
                  label: decision.uid,
                }}
                testId="decision-uid"
              />
            </dd>
            {decision.tenant && (
              <>
                <Term>tenant</Term>
                <Mono>{decision.tenant}</Mono>
              </>
            )}
            {email && (
              <>
                <Term>email</Term>
                <Mono>{email}</Mono>
              </>
            )}
            {decision.provider && (
              <>
                <Term>signed in with</Term>
                <Mono>{decision.provider}</Mono>
              </>
            )}
            {custom.map(([key, value]) => (
              <span key={key} className="contents">
                <Term>{key}</Term>
                <Mono>{claimText(value)}</Mono>
              </span>
            ))}
          </dl>
        )}
      </Section>

      <Section
        title="Decided by"
        note={
          rules === undefined
            ? 'The rules that decided it are no longer known to this page.'
            : sameRules || decision.allows.length === 0
              ? undefined
              : 'These lines are from the rules that were in force then, not the text in the editor.'
        }
      >
        {decision.allows.length === 0 ? (
          <Text size="sm" variant="secondary">
            {noRule}
          </Text>
        ) : (
          <RuleLines
            lines={countLines(
              decision.allows.map((allow) => ({
                line: allow.line,
                allowed: allow.outcome === 'allow',
              })),
            )}
            deciding={new Set(deciding)}
            rules={rules ?? ''}
            sameRules={sameRules}
            onReveal={onReveal}
          />
        )}
      </Section>

      <Section title="Why" testId="decision-why">
        {rerunPending ? (
          <Text size="sm" variant="secondary">
            Running it again for the values…
          </Text>
        ) : rerun && rules !== undefined ? (
          <>
            {rerun.result.outcome !== decision.outcome && (
              <Text size="xs" variant="secondary">
                Run again now it is {rerun.result.outcome === 'allow' ? 'allowed' : 'denied'}:{' '}
                {changedSince}
              </Text>
            )}
            <ExplanationView
              result={rerun.result}
              rules={rules}
              onReveal={sameRules ? onReveal : undefined}
              readFunctions={readFunctions}
            />
          </>
        ) : (
          <Text size="sm" variant="secondary" data-testid="decision-not-retained">
            {rerunError ? rerunError.message : EVICTED}
          </Text>
        )}
      </Section>

      {children}
    </div>
  )
}
