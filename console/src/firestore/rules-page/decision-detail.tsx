// One Firestore rules decision, opened: the rules kit's detail
// (`src/rules/decision-detail.tsx`) — who asked, the lines that decided it,
// why — with what Firestore knows of it: the query a list ran, the document
// before and the one a write would leave, and the document or collection
// it was about, one click away in Data.

import { Text } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import type { FirestoreDecision } from '@/api/generated/FirestoreDecision'
import { useLinkTo } from '@/lib/links'
import { DetailSection as Section, Mono, Term } from '@/rules/decision-parts'
import { DecisionDetailFrame } from '@/rules/decision-detail'
import { decodeFields } from '../value'
import { decisionQuery } from './api'
import { FieldList } from './field-list'
import { usePlayground } from './playground-store'
import { formFromDecision, formFromRequest } from './requests'

export function DecisionDetail({
  decision,
  rulesOf,
  editorSource,
  onReveal,
  onTry,
}: {
  decision: FirestoreDecision
  /** The text of the rules that decided it, when the page still has it (in force or in history). */
  rulesOf: (hash: string) => string | undefined
  /** The text in the editor: lines can be revealed only while it holds the deciding rules. */
  editorSource: string
  onReveal: (line: number) => void
  /** The playground has the request: show it. */
  onTry: () => void
}) {
  const loadPlayground = usePlayground((state) => state.load)
  // The decision run again by the engine, with the value of every
  // expression — and the request as it was recorded.
  const detail = useQuery(decisionQuery(decision.database, decision.id))
  const rerun = detail.data ?? undefined
  const files = useLinkTo(
    decision.method === 'list'
      ? { kind: 'firestore.collection', key: `${decision.database}|${decision.path}` }
      : { kind: 'firestore.document', key: `${decision.database}|${decision.path}` },
  )
  const writing =
    decision.method === 'create' || decision.method === 'update' || decision.method === 'delete'
  const query = rerun?.request.query
  const ordered = (query?.orderBy ?? []).map((order) => order.field.fieldPath)

  return (
    <DecisionDetailFrame
      decision={decision}
      scope={decision.database === '(default)' ? undefined : decision.database}
      rerun={
        rerun
          ? { rules: rerun.rules, result: rerun.result, claims: rerun.request.auth?.token ?? {} }
          : detail.data === null
            ? null
            : undefined
      }
      rerunPending={detail.isPending}
      rerunError={detail.error}
      rulesOf={rulesOf}
      editorSource={editorSource}
      onReveal={onReveal}
      onTry={() => {
        loadPlayground(
          rerun ? formFromRequest(rerun.request, decision.id) : formFromDecision(decision),
          { run: true },
        )
        onTry()
      }}
      open={{ label: 'Open in Data', link: files, testId: 'decision-open-data' }}
      wrong={decision.error ?? undefined}
      noRule={`No rule matched ${decision.path || 'this path'}, so it was denied by default.`}
      changedSince="data its rules read with get() or exists() has changed since."
    >
      {decision.method === 'list' && query && (
        <Section title="The query" testId="decision-query">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
            <Term>limit</Term>
            <Mono>{query.limit ?? 'none'}</Mono>
            {ordered.length > 0 && (
              <>
                <Term>ordered by</Term>
                <Mono>{ordered.join(', ')}</Mono>
              </>
            )}
          </dl>
        </Section>
      )}
      {decision.method !== 'list' && (
        <Section title={writing ? 'The document before' : 'The document'} testId="decision-before">
          {rerun ? (
            <FieldList
              fields={rerun.result.resource ? decodeFields(rerun.result.resource as never) : null}
              changed={rerun.result.changedKeys ?? undefined}
              absent="It does not exist."
            />
          ) : (
            <Text size="sm" variant="secondary">
              Not recorded in the feed.
            </Text>
          )}
        </Section>
      )}
      {writing && decision.method !== 'delete' && rerun && (
        <Section title="The document the write would leave" testId="decision-after">
          <FieldList
            fields={
              rerun.result.requestResource
                ? decodeFields(rerun.result.requestResource as never)
                : null
            }
            changed={rerun.result.changedKeys ?? undefined}
            absent="Nothing."
          />
        </Section>
      )}
    </DecisionDetailFrame>
  )
}
