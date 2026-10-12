// A schema's definition (S17, PS-52): the editor, checked as it is typed by
// the engine's own Avro parser with its reason placed in the text, and the
// status line under it — valid, or what is wrong — with the latest
// revision named. An older revision opens read-only in the same place, with
// the way back into the editor and the rollback beside it; a revision can
// also be diffed line by line against the text being edited.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  CheckCircleIcon,
  PencilSimpleIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { PubsubSchemaDetail } from '@/api/generated/messaging/PubsubSchemaDetail'
import type { PubsubSchemaRevision } from '@/api/generated/messaging/PubsubSchemaRevision'
import { CodeEditor } from '@/components/code-editor'
import { RelativeTime } from '@/components/console/relative-time'
import { type DiffLine, diffLines, diffSize } from '@/firestore/rules-page/diff'
import { describeKey } from '@/lib/shortcuts'
import { schemaCheckQuery } from '../queries'
import {
  checkLine,
  checkMarks,
  prettyDefinition,
  revisionLabel,
  sameDefinition,
} from './schema-text'

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
  revision,
  diff,
  onCloseRevision,
  onRollback,
  rolling,
}: {
  project: string
  detail: PubsubSchemaDetail
  /** The editor's text. */
  draft: string
  onDraft: (text: string) => void
  /** An older revision shown read-only (`revision=`), or the editor. */
  revision: PubsubSchemaRevision | undefined
  /** A revision diffed against the editor (`diff=`). */
  diff: PubsubSchemaRevision | undefined
  /** Back to the editor (the parameter's own value removed). */
  onCloseRevision: () => void
  onRollback: (revision: PubsubSchemaRevision) => void
  rolling: boolean
}) {
  const latest = detail.revisions.at(-1)
  if (revision && revision.id !== latest?.id)
    return (
      <RevisionView
        revision={revision}
        draft={draft}
        onPut={() => {
          onDraft(prettyDefinition(revision.definition))
          onCloseRevision()
        }}
        onRollback={() => onRollback(revision)}
        rolling={rolling}
        onClose={onCloseRevision}
      />
    )
  if (diff) return <DiffPane revision={diff} draft={draft} onClose={onCloseRevision} />
  return <DefinitionEditor project={project} detail={detail} draft={draft} onDraft={onDraft} />
}

function DefinitionEditor({
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

/** A bar over the editor's place: what is shown instead of the editor, and the way back. */
function Bar({
  children,
  actions,
  onClose,
  testId,
}: {
  children: React.ReactNode
  actions?: React.ReactNode
  onClose: () => void
  testId: string
}) {
  return (
    <div
      className="flex min-h-9 shrink-0 items-center gap-2 border-b border-kumo-line bg-kumo-tint px-3 py-1 text-[13px]"
      data-testid={testId}
    >
      <span className="min-w-0 flex-1 truncate text-kumo-default">{children}</span>
      {actions}
      <Tooltip
        content="Back to the editor"
        render={
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<XIcon />}
            aria-label="Back to the editor"
            onClick={onClose}
            data-testid={`${testId}-close`}
          />
        }
      />
    </div>
  )
}

function RevisionView({
  revision,
  draft,
  onPut,
  onRollback,
  rolling,
  onClose,
}: {
  revision: PubsubSchemaRevision
  draft: string
  onPut: () => void
  onRollback: () => void
  rolling: boolean
  onClose: () => void
}) {
  const text = prettyDefinition(revision.definition)
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={`Revision ${revision.id}`}
      data-testid="pubsub-schema-revision"
    >
      <Bar
        testId="pubsub-schema-revision-bar"
        onClose={onClose}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<PencilSimpleIcon />}
              disabled={sameDefinition(revision.definition, draft)}
              onClick={onPut}
              data-testid="pubsub-schema-put"
            >
              Put in the editor
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<ArrowCounterClockwiseIcon />}
              loading={rolling}
              onClick={onRollback}
              data-testid="pubsub-schema-rollback"
            >
              Roll back to this
            </Button>
          </>
        }
      >
        Revision <span className="font-mono text-[12px]">{revisionLabel(revision.id)}</span>{' '}
        <span className="text-kumo-subtle">
          · <RelativeTime iso={revision.createdAt} prefix="made" className="text-[13px]" /> ·
          read-only
        </span>
      </Bar>
      <div className="flex min-h-0 flex-1 flex-col">
        <CodeEditor
          value={text}
          onChange={() => {}}
          language="json"
          readOnly
          ariaLabel={`Revision ${revision.id}`}
          testId="pubsub-schema-revision-source"
        />
      </div>
    </section>
  )
}

function DiffPane({
  revision,
  draft,
  onClose,
}: {
  revision: PubsubSchemaRevision
  draft: string
  onClose: () => void
}) {
  const lines = diffLines(prettyDefinition(revision.definition), prettyDefinition(draft))
  const size = diffSize(lines)
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={`Revision ${revision.id} against the editor`}
      data-testid="pubsub-schema-diff"
    >
      <Bar testId="pubsub-schema-diff-bar" onClose={onClose}>
        Revision <span className="font-mono text-[12px]">{revisionLabel(revision.id)}</span>{' '}
        <span className="text-kumo-subtle">
          against the editor:{' '}
          {size.added + size.removed === 0
            ? 'the same'
            : `${size.added} ${size.added === 1 ? 'line' : 'lines'} added, ${size.removed} removed`}
        </span>
      </Bar>
      <DiffView lines={lines} />
    </section>
  )
}

/** A diff read top to bottom: the revision's line numbers, then the editor's. */
export function DiffView({ lines }: { lines: readonly DiffLine[] }) {
  if (lines.length === 0)
    return (
      <div className="p-4">
        <Text size="sm" variant="secondary">
          Both are empty.
        </Text>
      </div>
    )
  return (
    <div
      className="min-h-0 flex-1 overflow-auto bg-kumo-control"
      data-testid="pubsub-schema-diff-lines"
    >
      <table className="w-full border-collapse font-mono text-[12px] leading-5">
        <tbody>
          {lines.map((line, index) => (
            <tr
              // A diff line has no identity of its own; its place in the
              // diff is what it is.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className={
                line.kind === 'added'
                  ? 'bg-kumo-success-tint'
                  : line.kind === 'removed'
                    ? 'bg-kumo-danger-tint'
                    : ''
              }
              data-kind={line.kind}
            >
              <td className="w-10 pr-2 text-right text-kumo-inactive tabular-nums select-none">
                {line.before ?? ''}
              </td>
              <td className="w-10 pr-2 text-right text-kumo-inactive tabular-nums select-none">
                {line.after ?? ''}
              </td>
              <td className="w-4 text-kumo-subtle select-none">
                {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
              </td>
              <td className="pr-4 whitespace-pre text-kumo-default">{line.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
