// One Storage rules decision, opened: who asked, what the file was and what
// the request proposed, the lines that decided it, and why — the engine
// runs the recorded request again against the rules that decided it and
// says the value every expression had. A decision older than the engine's
// re-runnable window keeps its verdict and lines from the feed, and the
// playground takes the request from what the feed recorded.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, FlaskIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import { EntityLink } from '@/components/console/entity-link'
import { formatClock, useClockFormat } from '@/lib/format'
import { useLinkTo } from '@/lib/links'
import { DetailSection as Section, Mono, RuleLines, Term, countLines } from '@/rules/decision-parts'
import { inlineSteps } from '@/rules/explain'
import { ExplanationView } from '@/rules/explanation-view'
import { linesFromAllows, useOverlay } from '@/rules/overlay'
import { Verdict } from '@/rules/verdict'
import { storageDecisionQuery } from '../queries'
import { EVICTED, decidingLines } from './decisions'
import { ObjectFacts, sizeText } from './object-facts'
import { usePlayground } from './playground-store'
import { formFromDecision, formFromRequest } from './requests'

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

/** How Storage's rules spell their two document reads. */
export const STORAGE_READS: readonly [string, string] = ['firestore.get()', 'firestore.exists()']

function claimText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function DecisionDetail({
  project,
  scope,
  decision,
  rulesOf,
  editorSource,
  onReveal,
  onTry,
}: {
  project: string
  scope: string
  decision: StorageDecision
  /** The text of the rules that decided it, when the page still has it (in force or in history). */
  rulesOf: (hash: string) => string | undefined
  /** The text in the editor: lines can be revealed only while it holds the deciding rules. */
  editorSource: string
  onReveal: (line: number) => void
  /** The playground has the request: show it. */
  onTry: () => void
}) {
  const loadPlayground = usePlayground((state) => state.load)
  const show = useOverlay((state) => state.show)
  const clear = useOverlay((state) => state.clear)
  const { format } = useClockFormat()
  const navigate = useNavigate()
  const detail = useQuery(storageDecisionQuery(project, scope, decision.id))
  const rerun = detail.data ?? undefined
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
  const files = useLinkTo(
    decision.method === 'list'
      ? { kind: 'storage.folder', key: `${decision.bucket}|${decision.path}` }
      : { kind: 'storage.object', key: `${decision.bucket}|${decision.path}` },
  )
  const writing = decision.method === 'create' || decision.method === 'update'

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
        <span className="font-mono text-[11px] text-kumo-subtle">gs://{decision.bucket}</span>
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            icon={<FlaskIcon />}
            onClick={() => {
              loadPlayground(
                rerun ? formFromRequest(rerun.request, decision.id) : formFromDecision(decision),
              )
              onTry()
            }}
            data-testid="decision-try"
          >
            Try in the playground
          </Button>
          {files && (
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowSquareOutIcon />}
              onClick={() => void navigate({ to: files.to, search: files.search } as never)}
              data-testid="decision-open-files"
            >
              Open in Files
            </Button>
          )}
        </span>
      </div>

      {(decision.error || decision.noRuleset) && (
        <Section title="What went wrong">
          <Text size="sm" variant="error">
            {decision.noRuleset
              ? `No rules govern gs://${decision.bucket}, so the emulator refused the request. ${decision.error ?? ''}`.trim()
              : decision.error}
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
            {decision.noRuleset
              ? 'No rule ran: nothing governs this bucket.'
              : `No rule matched ${decision.path || 'this path'}, so it was denied by default.`}
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
        {detail.isPending ? (
          <Text size="sm" variant="secondary">
            Running it again for the values…
          </Text>
        ) : rerun && rules !== undefined ? (
          <>
            {rerun.result.outcome !== decision.outcome && (
              <Text size="xs" variant="secondary">
                Run again now it is {rerun.result.outcome === 'allow' ? 'allowed' : 'denied'}: a
                document its rules read with firestore.get() or firestore.exists() has changed
                since.
              </Text>
            )}
            <ExplanationView
              result={rerun.result}
              rules={rules}
              onReveal={sameRules ? onReveal : undefined}
              readFunctions={STORAGE_READS}
            />
          </>
        ) : (
          <Text size="sm" variant="secondary" data-testid="decision-not-retained">
            {detail.isError ? detail.error.message : EVICTED}
          </Text>
        )}
      </Section>

      {decision.method !== 'list' && (
        <Section title={writing ? 'The file before' : 'The file'} testId="decision-before">
          {rerun ? (
            <ObjectFacts
              object={rerun.result.resource}
              changed={rerun.result.changedKeys}
              absent="It did not exist."
            />
          ) : (
            <Text size="sm" variant="secondary">
              Not recorded in the feed.
            </Text>
          )}
        </Section>
      )}
      {writing && (
        <Section
          title={decision.method === 'create' ? 'The upload' : 'The file the change would leave'}
          testId="decision-proposed"
        >
          {rerun?.result.requestResource ? (
            <ObjectFacts
              object={rerun.result.requestResource}
              changed={rerun.result.changedKeys}
              absent="Nothing."
            />
          ) : (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
              <Term>size</Term>
              <Mono>{decision.size === null ? 'unknown' : sizeText(decision.size)}</Mono>
              <Term>contentType</Term>
              <Mono>{decision.contentType ?? 'none'}</Mono>
            </dl>
          )}
        </Section>
      )}
    </div>
  )
}
