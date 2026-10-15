// One Storage rules decision, opened: the rules kit's detail
// (`src/rules/decision-detail.tsx`) — who asked, the lines that decided it,
// why — with what Storage knows of it: the bucket, the file before and the
// one the request proposed, and the file or folder one click away in Files.

import { useQuery } from '@tanstack/react-query'
import { Text } from '@cloudflare/kumo'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import { useLinkTo } from '@/lib/links'
import { DetailSection as Section, Mono, Term } from '@/rules/decision-parts'
import { DecisionDetailFrame } from '@/rules/decision-detail'
import { storageDecisionQuery } from '../queries'
import { ObjectFacts, sizeText } from './object-facts'
import { usePlayground } from './playground-store'
import { formFromDecision, formFromRequest } from './requests'

/** How Storage's rules spell their two document reads. */
export const STORAGE_READS: readonly [string, string] = ['firestore.get()', 'firestore.exists()']

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
  const detail = useQuery(storageDecisionQuery(project, scope, decision.id))
  const rerun = detail.data ?? undefined
  const files = useLinkTo(
    decision.method === 'list'
      ? { kind: 'storage.folder', key: `${decision.bucket}|${decision.path}` }
      : { kind: 'storage.object', key: `${decision.bucket}|${decision.path}` },
  )
  const writing = decision.method === 'create' || decision.method === 'update'

  return (
    <DecisionDetailFrame
      decision={decision}
      scope={`gs://${decision.bucket}`}
      rerun={
        rerun
          ? { rules: rerun.rules, result: rerun.result, claims: rerun.claims }
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
      open={{ label: 'Open in Files', link: files, testId: 'decision-open-files' }}
      wrong={
        decision.noRuleset
          ? `No rules govern gs://${decision.bucket}, so the emulator refused the request. ${decision.error ?? ''}`.trim()
          : (decision.error ?? undefined)
      }
      noRule={
        decision.noRuleset
          ? 'No rule ran: nothing governs this bucket.'
          : `No rule matched ${decision.path || 'this path'}, so it was denied by default.`
      }
      readFunctions={STORAGE_READS}
      changedSince="a document its rules read with firestore.get() or firestore.exists() has changed since."
    >
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
    </DecisionDetailFrame>
  )
}
