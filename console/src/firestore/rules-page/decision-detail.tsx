// One decision, opened: who asked, what the document was and would have
// been, and the lines that decided it. It used to open onto the raw event
// — the whole rules file as one escaped string at the top — and widened
// the table it sat in until the columns beside it slid out of view.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import { FlaskIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { FsValue } from '../value'
import { displayValue } from '../value'
import { decisionQuery } from './api'
import { type RulesDecision, decidingLines, linesRun } from './decisions'
import { Verdict } from './decisions-panel'
import { FieldList } from './field-list'
import { inlineSteps } from './explain'
import { ExplanationView } from './explanation-view'
import { useOverlay } from './overlay'
import { usePlayground } from './playground-store'
import { formFromRequest } from './requests'
import { useRulesSearch } from './rules-search'

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

/** A line of a ruleset, trimmed, for showing beside its number. */
export function ruleLine(rules: string, line: number): string {
  return (rules.split('\n')[line - 1] ?? '').trim()
}

function claim(token: Record<string, FsValue> | undefined, path: string): string | undefined {
  let value: FsValue | undefined = undefined
  let fields = token
  for (const part of path.split('.')) {
    value = fields?.[part]
    fields = value?.type === 'map' ? value.fields : undefined
  }
  return value && value.type !== 'map' ? displayValue(value) : undefined
}

export function DecisionDetail({
  decision,
  database,
  sameRules,
  onReveal,
}: {
  decision: RulesDecision
  database: string
  sameRules: boolean
  onReveal: (line: number) => void
}) {
  const { update } = useRulesSearch()
  const loadPlayground = usePlayground((state) => state.load)
  const show = useOverlay((state) => state.show)
  const clear = useOverlay((state) => state.clear)
  // The decision run again by the engine, with the value of every
  // expression — the "why" the feed's event does not carry.
  const detail = useQuery(decisionQuery(database, decision.requestId))
  const rerun = detail.data && detail.data.rules === decision.rules ? detail.data : undefined

  // Drawn into the editor: the lines it went through, and the values its
  // expressions had, over the rules that decided it.
  useEffect(() => {
    const decidingSet = new Set(decidingLines(decision))
    show({
      owner: 'decision',
      source: decision.rules,
      lineMarks: linesRun(decision).map((line) => ({
        line: line.line,
        tone: decidingSet.has(line.line)
          ? decision.outcome === 'allow'
            ? 'allow'
            : 'deny'
          : 'focus',
      })),
      values: rerun ? inlineSteps(rerun.result.explanation, decision.rules) : [],
      reveal: decidingLines(decision)[0] ?? decision.lines[0]?.line,
    })
  }, [decision, rerun, show])
  useEffect(() => () => clear('decision'), [clear])

  const deciding = new Set(decidingLines(decision))
  const custom = Object.entries(decision.token ?? {}).filter(([key]) => !STANDARD_CLAIMS.has(key))
  const provider = claim(decision.token, 'firebase.sign_in_provider')
  const email = claim(decision.token, 'email')
  const writing =
    decision.method === 'create' || decision.method === 'update' || decision.method === 'delete'

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="decision-detail">
      <div className="grid gap-1 border-b border-kumo-line px-3 py-3">
        <div className="flex items-center gap-2">
          <Verdict outcome={decision.outcome} />
          <span className="font-mono text-[12px] text-kumo-subtle">{decision.method}</span>
          <Tooltip
            content={decision.time}
            render={
              <span className="ml-auto text-[12px] text-kumo-subtle tabular-nums">
                {new Date(decision.time).toLocaleTimeString()}
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
        {rerun && (
          <span className="mt-1.5 flex">
            <Button
              variant="secondary"
              size="sm"
              icon={<FlaskIcon />}
              onClick={() => {
                loadPlayground(formFromRequest(rerun.request, decision.requestId))
                update({ panel: 'playground' })
              }}
              data-testid="decision-try"
            >
              Try in the playground
            </Button>
          </span>
        )}
      </div>

      <Section title="Who asked">
        {decision.uid === undefined ? (
          <Text size="sm">Not signed in</Text>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <Term>uid</Term>
            <Mono>{decision.uid}</Mono>
            {email && (
              <>
                <Term>email</Term>
                <Mono>{email}</Mono>
              </>
            )}
            {provider && (
              <>
                <Term>signed in with</Term>
                <Mono>{provider}</Mono>
              </>
            )}
            {custom.map(([key, value]) => (
              <span key={key} className="contents">
                <Term>{key}</Term>
                <Mono>{displayValue(value)}</Mono>
              </span>
            ))}
          </dl>
        )}
      </Section>

      <Section
        title="Decided by"
        note={
          sameRules || decision.lines.length === 0
            ? undefined
            : 'These lines are from the rules that were in force then, not the text in the editor.'
        }
      >
        {decision.lines.length === 0 ? (
          <Text size="sm" variant="secondary">
            No rule matched {decision.path || 'this path'}, so it was denied by default.
          </Text>
        ) : (
          <ul className="grid min-w-0 gap-0.5" data-testid="decision-lines">
            {linesRun(decision).map((line) => (
              <li key={`${line.line}-${line.outcome}`} className="min-w-0">
                <button
                  type="button"
                  disabled={!sameRules}
                  onClick={() => onReveal(line.line)}
                  className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left enabled:hover:ink disabled:cursor-default"
                >
                  <span className="w-14 shrink-0 font-mono text-[11px] whitespace-nowrap text-kumo-subtle tabular-nums">
                    line {line.line}
                  </span>
                  <span
                    className={`w-12 shrink-0 text-[11px] ${
                      line.outcome ? 'text-kumo-success' : 'text-kumo-danger'
                    }`}
                  >
                    {line.outcome ? 'allowed' : 'refused'}
                  </span>
                  <span
                    className={`min-w-0 truncate font-mono text-[12px] ${
                      deciding.has(line.line) ? 'text-kumo-default' : 'text-kumo-subtle'
                    }`}
                  >
                    {ruleLine(decision.rules, line.line)}
                  </span>
                  {line.times > 1 && (
                    <span className="ml-auto shrink-0 text-[11px] text-kumo-subtle tabular-nums">
                      ×{line.times}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Why">
        {detail.isPending ? (
          <Text size="sm" variant="secondary">
            Running it again for the values…
          </Text>
        ) : rerun ? (
          <>
            {rerun.result.outcome !== decision.outcome && (
              <Text size="xs" variant="secondary">
                Run again now it is {rerun.result.outcome === 'allow' ? 'allowed' : 'denied'}: data
                its rules read with get() or exists() has changed since.
              </Text>
            )}
            <ExplanationView
              result={rerun.result}
              rules={decision.rules}
              onReveal={sameRules ? onReveal : undefined}
            />
          </>
        ) : (
          <Text size="sm" variant="secondary" data-testid="decision-not-retained">
            {detail.isError
              ? detail.error.message
              : 'The values are no longer available: the engine keeps them for the last 256 decisions of the last ten minutes.'}
          </Text>
        )}
      </Section>

      {decision.method === 'list' && decision.query && (
        <Section title="The query">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <Term>limit</Term>
            <Mono>{decision.query.limit ?? 'none'}</Mono>
            {decision.query.orderBy.length > 0 && (
              <>
                <Term>ordered by</Term>
                <Mono>{decision.query.orderBy.join(', ')}</Mono>
              </>
            )}
          </dl>
        </Section>
      )}

      {decision.before !== undefined && (
        <Section title={writing ? 'The document before' : 'The document'}>
          <FieldList
            fields={decision.before}
            changed={decision.changedKeys}
            absent="It does not exist."
          />
        </Section>
      )}
      {writing && decision.method !== 'delete' && (
        <Section title="The document the write would leave">
          <FieldList fields={decision.after} changed={decision.changedKeys} absent="Nothing." />
        </Section>
      )}
    </div>
  )
}

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string | undefined
  children: React.ReactNode
}) {
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-b border-kumo-line px-3 py-3">
      <Text as="h3" size="xs" bold>
        {title}
      </Text>
      {note && (
        <Text size="xs" variant="secondary">
          {note}
        </Text>
      )}
      {children}
    </section>
  )
}

function Term({ children }: { children: React.ReactNode }) {
  return <dt className="text-kumo-subtle">{children}</dt>
}

function Mono({ children }: { children: React.ReactNode }) {
  return <dd className="min-w-0 truncate font-mono text-kumo-default">{children}</dd>
}
