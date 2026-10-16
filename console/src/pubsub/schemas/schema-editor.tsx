// A schema's definition (S17, PS-52): the editor, checked as it is typed by
// the engine's own Avro parser with its reason placed in the text, and the
// status line under it — valid, or what is wrong — with the latest
// revision named. Committing the text makes a new revision.

import { CheckCircleIcon, PencilSimpleIcon, WarningIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { PubsubSchemaDetail } from '@/api/generated/messaging/PubsubSchemaDetail'
import { CodeEditor } from '@/components/code-editor'
import { RelativeTime } from '@/components/console/relative-time'
import { describeKey } from '@/lib/shortcuts'
import { schemaCheckQuery } from '../queries'
import { checkLine, checkMarks, revisionLabel, sameDefinition } from './schema-text'

/** A value that settles: the latest after it has stopped changing for `ms`. */
export function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** Whether `text` parses as a definition, by the engine's parser, once it settles. */
export function useDefinitionCheck(project: string, kind: string, text: string) {
  const settled = useSettled(text)
  const check = useQuery(schemaCheckQuery(project, kind, settled))
  const current = settled === text && text.trim() !== '' ? check.data : undefined
  return { check: current, pending: settled !== text || check.isFetching }
}

export function SchemaEditor({
  project,
  detail,
  draft,
  onDraft,
}: {
  project: string
  detail: PubsubSchemaDetail
  draft: string
  onDraft: (text: string) => void
}) {
  const latest = detail.revisions.at(-1)
  const { check } = useDefinitionCheck(project, detail.kind, draft)
  const marks = checkMarks(draft, check)
  const problem = checkLine(check)
  const edited = latest !== undefined && !sameDefinition(draft, latest.definition)
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Definition"
      data-testid="pubsub-schema-definition"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <CodeEditor
          value={draft}
          onChange={onDraft}
          language="json"
          marks={marks}
          ariaLabel={`Definition of ${detail.id}`}
          testId="pubsub-schema-source"
        />
      </div>
      <div
        className={`flex min-h-8 shrink-0 items-center gap-2 border-t px-3 py-1.5 text-[13px] ${
          problem ? 'border-kumo-danger bg-kumo-danger-tint' : 'border-kumo-line'
        }`}
        role="status"
        data-testid="pubsub-schema-status"
        data-valid={check?.ok ? '' : undefined}
      >
        {problem ? (
          <>
            <WarningIcon size={14} className="shrink-0 text-kumo-danger" />
            <span className="min-w-0 font-mono text-[12px] text-kumo-default">{problem}</span>
          </>
        ) : (
          <>
            <CheckCircleIcon
              size={14}
              className={check?.ok ? 'shrink-0 text-kumo-success' : 'shrink-0 text-kumo-inactive'}
            />
            <span className="min-w-0 truncate text-kumo-default">
              {check?.ok ? 'Valid Avro' : 'Checking…'}
            </span>
            {latest && (
              <span className="flex min-w-0 items-center gap-1.5 text-kumo-subtle">
                <span aria-hidden>·</span>
                latest revision
                <span className="font-mono text-[12px] text-kumo-default">
                  {revisionLabel(latest.id)}
                </span>
                <span aria-hidden>·</span>
                <RelativeTime iso={latest.createdAt} />
              </span>
            )}
            {edited && (
              <span
                className="ml-auto flex shrink-0 items-center gap-1 text-kumo-subtle"
                data-testid="pubsub-schema-edited"
              >
                <PencilSimpleIcon size={13} />
                Edited · {describeKey('Mod+s')} commits it as a new revision
              </span>
            )}
          </>
        )}
      </div>
    </section>
  )
}
