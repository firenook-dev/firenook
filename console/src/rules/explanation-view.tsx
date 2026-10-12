// Why the rules decided what they did, read top to bottom: each condition
// that ran, the value every part of it had, and what a list query lacked.
// The editor shows the same values inline; this is the version that reads
// as a sentence, for a condition too long to scan on its line, and for the
// parts that ran inside functions it called. Firestore's and Storage's
// results both read this way; only Firestore's lists have a `queryReason`
// and a document cache.

import { Text } from '@cloudflare/kumo'
import { WarningIcon } from '@phosphor-icons/react'
import type { AllowTrace } from '@/api/generated/AllowTrace'
import type { ExplainStep } from '@/api/generated/ExplainStep'
import type { RulesOutcome } from '@/api/generated/RulesOutcome'
import { inlineSteps } from './explain'

/** What an evaluation answers with, whichever service's rules ran. */
export interface ExplainedResult {
  outcome: RulesOutcome
  error: string | null
  allows: AllowTrace[]
  explanation: ExplainStep[]
  truncated: boolean
  documentAccesses: number
  documentAccessLimit: number
  /** Reads `get()`/`exists()` were served from the evaluation's cache (Firestore). */
  documentCacheHits?: number | undefined
  /** A denied list: what the query must filter on for the rules to hold (Firestore). */
  queryReason?: string | null | undefined
}

/** How Firestore's rules spell their two document reads. */
const DOCUMENT_READS: readonly [string, string] = ['get()', 'exists()']

function outcomeWord(outcome: AllowTrace['outcome']): string {
  return outcome === 'allow' ? 'allowed' : outcome === 'deny' ? 'refused' : 'raised an error'
}

function valueTone(value: string, error: boolean): string {
  if (error) return 'text-kumo-danger'
  if (value === 'true') return 'text-kumo-success'
  if (value === 'false') return 'text-kumo-danger'
  return 'text-kumo-default'
}

/** Line and column of a UTF-16 offset, one-based. */
function lineOf(rules: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < rules.length; index += 1)
    if (rules.charCodeAt(index) === 10) line += 1
  return line
}

export function ExplanationView({
  result,
  rules,
  onReveal,
  readFunctions = DOCUMENT_READS,
}: {
  result: ExplainedResult
  /** The rules source the offsets refer to. */
  rules: string
  /** Bring a line of these rules into view in the editor, when the editor holds them. */
  onReveal?: ((line: number) => void) | undefined
  /** How the rules language spells its two document reads: Storage's are `firestore.get()`. */
  readFunctions?: readonly [string, string]
}) {
  const [getter, exister] = readFunctions
  const steps = inlineSteps(result.explanation, rules)
  // The allows that decided it first, then the ones that merely ran.
  const deciding = (allow: AllowTrace) =>
    result.outcome === 'allow' ? allow.outcome === 'allow' : allow.outcome !== 'allow'
  const allows = [...result.allows].toSorted(
    (left, right) => Number(deciding(right)) - Number(deciding(left)),
  )
  const inside = steps.filter(
    (step) => !result.allows.some((allow) => step.from >= allow.from && step.to <= allow.to),
  )

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3" data-testid="explanation">
      {result.queryReason && (
        <div
          className="flex gap-2 rounded-md bg-kumo-warning-tint p-2.5 text-[13px] ring ring-kumo-warning"
          data-testid="query-reason"
        >
          <WarningIcon size={14} className="mt-0.5 shrink-0 text-kumo-warning" />
          <span className="text-kumo-default">{result.queryReason}</span>
        </div>
      )}
      {result.error && !result.queryReason && (
        <Text size="sm" variant="error">
          {result.error}
        </Text>
      )}
      {result.allows.length === 0 && (
        <Text size="sm" variant="secondary">
          No allow matched this path and operation, so it was denied by default.
        </Text>
      )}
      {allows.map((allow, index) => {
        // The condition's own value is the verdict written above it.
        const own = steps.filter(
          (step) =>
            step.from >= allow.from &&
            step.to <= allow.to &&
            !(step.from === allow.from && step.to === allow.to),
        )
        return (
          <div
            // An allow can run more than once (a query proves each branch);
            // its place in the run is its identity.
            // oxlint-disable-next-line react/no-array-index-key
            key={`${allow.from}-${index}`}
            className="grid min-w-0 gap-1.5"
            data-testid="explained-allow"
          >
            <button
              type="button"
              disabled={!onReveal}
              onClick={() => onReveal?.(allow.line)}
              className="flex min-w-0 items-baseline gap-2 text-left enabled:hover:underline disabled:cursor-default"
            >
              <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
                line {allow.line}
              </span>
              <span
                className={`shrink-0 text-[11px] ${
                  allow.outcome === 'allow' ? 'text-kumo-success' : 'text-kumo-danger'
                }`}
              >
                {outcomeWord(allow.outcome)}
              </span>
            </button>
            <code className="block rounded bg-kumo-control px-2 py-1.5 font-mono text-[12px] break-words whitespace-pre-wrap text-kumo-default">
              {rules.slice(allow.from, allow.to)}
            </code>
            {own.length > 0 && <Steps steps={own} rules={rules} />}
          </div>
        )
      })}
      {inside.length > 0 && (
        <div className="grid min-w-0 gap-1.5">
          <Text size="xs" variant="secondary">
            Inside the functions it called
          </Text>
          <Steps steps={inside} rules={rules} lines />
        </div>
      )}
      {result.truncated && (
        <Text size="xs" variant="secondary">
          The evaluation was longer than the engine records; the last steps are not shown.
        </Text>
      )}
      <Text size="xs" variant="secondary">
        {result.documentAccesses === 0
          ? `No document reads: the rules called neither ${getter} nor ${exister}.`
          : `${result.documentAccesses} of ${result.documentAccessLimit} document reads used by ${getter} and ${exister}${
              (result.documentCacheHits ?? 0) > 0
                ? `, ${result.documentCacheHits} served from cache`
                : ''
            }. In production each is a billed read.`}
      </Text>
    </div>
  )
}

function Steps({
  steps,
  rules,
  lines = false,
}: {
  steps: ReturnType<typeof inlineSteps>
  rules: string
  lines?: boolean
}) {
  return (
    <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-[12px]">
      {steps.map((step) => (
        <span key={`${step.from}:${step.to}`} className="contents">
          <dt className="min-w-0 truncate font-mono text-kumo-subtle">
            {lines ? `${lineOf(rules, step.from)}: ` : ''}
            {rules.slice(step.from, step.to)}
          </dt>
          <dd
            className={`max-w-[16rem] truncate text-right font-mono ${valueTone(step.value, step.error ?? false)}`}
            data-step-value
          >
            {step.value}
          </dd>
        </span>
      ))}
    </dl>
  )
}
