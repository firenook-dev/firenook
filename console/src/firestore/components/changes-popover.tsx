// Recent changes, and putting one back.
//
// It hangs off the live indicator, because "3 changes" invites exactly one
// question. Every write the emulator accepted is here — the console's own,
// the app's, a trigger's — newest first, each with the documents it touched
// and an undo that restores the exact documents it replaced.

import { Badge, Button, Popover, Text, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowCounterClockwiseIcon, CaretRightIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { LiveDot, PanelTitle, type LiveState } from '@/components/kit'
import { ApiError } from '@/api/client'
import {
  type FieldChange,
  type LoggedCommit,
  changeLogQuery,
  commitDiffQuery,
  describeCommit,
  documentName,
  undoBlockedBecause,
  undoCommit,
  undoSays,
} from '../changelog'
import { type RestValue, decodeValue, displayValue, relativeTime } from '../value'
import { useWorkbench } from './workbench-context'

export function ChangesPopover({ state, changes }: { state: LiveState; changes: number }) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const [open, setOpen] = useState(false)
  // Nobody is reading the window while the popover is shut, and the live
  // channel invalidates it on every commit, so asking only while it is
  // open keeps a busy database from refetching it over and over.
  const log = useQuery({ ...changeLogQuery(workbench.database), enabled: open })

  const undo = useMutation({
    mutationFn: (commit: LoggedCommit) => undoCommit(commit.id),
    onSuccess: (result) => {
      toasts.add({
        title:
          result.documents === 1
            ? 'Change undone'
            : `Change undone · ${result.documents} documents`,
        description: 'The documents are back as they were before that write.',
        variant: 'success',
      })
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.database] })
    },
    onError: (error) => {
      toasts.add({
        title: 'Nothing was undone',
        description: error instanceof Error ? error.message : String(error),
        variant: 'error',
      })
    },
  })

  // The engine keeps the window only while diagnostics are on, so the route
  // is simply absent otherwise; say that rather than show an empty list.
  const off = log.error instanceof ApiError && log.error.status === 404

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="flex h-7 items-center rounded-md px-1.5 hover:bg-kumo-tint"
            aria-label="Recent changes"
            data-testid="changes-trigger"
          >
            {/* The word goes before the state does: a crowded toolbar still
                has to say whether the channel is up. */}
            <span className="hidden xl:flex">
              <LiveDot state={state} changes={changes} />
            </span>
            <span className="flex xl:hidden">
              <LiveDot state={state} changes={changes} compact />
            </span>
          </button>
        }
      />
      <Popover.Content className="w-[440px] max-w-[calc(100vw-2rem)]">
        {/* Kumo's Popover.Content drops unknown props, so the test id and
            the layout live on a div of our own inside it. */}
        <div className="grid gap-2" data-testid="changes-popover">
          <div className="flex items-baseline justify-between gap-3">
            <PanelTitle>Recent changes</PanelTitle>
            {/* "held", and it says what holds them. "3 kept" reads as an
                outcome — three of your changes were kept — when it is the
                size of a window that drops its oldest. */}
            {log.data && log.data.retained > 0 && (
              <Text
                variant="secondary"
                size="sm"
                DANGEROUS_className="cursor-help"
                title="The engine holds up to 200 recent commits, or 8 MB of documents, while diagnostics are on. Older ones fall off."
              >
                {log.data.retained.toLocaleString('en-US')} held
              </Text>
            )}
          </div>
          {off ? (
            <Text variant="secondary" size="sm">
              The engine keeps recent changes only while diagnostics are on. This one was started
              with <span className="font-mono text-[0.9em]">--no-diagnostics</span>.
            </Text>
          ) : log.isError ? (
            <Text variant="error" size="sm">
              {log.error.message}
            </Text>
          ) : log.data?.commits.length === 0 ? (
            <Text variant="secondary" size="sm">
              Nothing has been written to this database since the emulator started.
            </Text>
          ) : (
            <ul className="-mx-1 grid max-h-96 gap-0.5 overflow-y-auto">
              {log.data?.commits.map((commit) => (
                <CommitRow
                  key={commit.id}
                  commit={commit}
                  busy={undo.isPending && undo.variables?.id === commit.id}
                  database={workbench.database}
                  onUndo={() => undo.mutate(commit)}
                  onOpen={(path) => workbench.selectDocument(path)}
                />
              ))}
            </ul>
          )}
        </div>
      </Popover.Content>
    </Popover>
  )
}

/** One side of a field's move, or the dash that says it was not there. */
function Side({ value, tone }: { value: unknown; tone: 'before' | 'after' }) {
  if (value === null || value === undefined) return <span className="text-kumo-inactive">—</span>
  const text = displayValue(decodeValue(value as RestValue))
  return (
    <span
      className={`truncate font-mono text-[11px] ${
        tone === 'before' ? 'text-kumo-subtle line-through' : 'text-kumo-default'
      }`}
      title={text}
    >
      {text}
    </span>
  )
}

/**
 * What a commit did to one document, field by field.
 *
 * A row used to say "1 updated" and name a path, which is the question
 * restated rather than answered. The engine has held the before-image all
 * along for the undo; this is the same data, read.
 */
function Diff({ database, id }: { database: string; id: number }) {
  const diff = useQuery(commitDiffQuery(database, id))
  if (diff.isPending)
    return (
      <Text variant="secondary" size="sm">
        Reading what changed…
      </Text>
    )
  // Say what the engine said. This asserted "no longer held", which is
  // the rarest of the reasons and was wrong for the common one: a
  // commit listed a second ago has not fallen out of the window, and an
  // engine older than this panel simply has no diff route — a bare 404
  // that read as a confident claim about eviction.
  if (diff.isError || !diff.data)
    return (
      <Text variant="secondary" size="sm">
        Could not read what changed
        {diff.error instanceof Error ? `: ${diff.error.message}` : '.'}
      </Text>
    )
  if (!diff.data.retained)
    return (
      <Text variant="secondary" size="sm">
        Too large to keep what it replaced, so only the paths are here.
      </Text>
    )
  return (
    <div className="grid gap-1.5 border-l border-kumo-line pl-2">
      {diff.data.documents.map((document) => (
        <div key={document.path} className="grid gap-0.5">
          {/* The chips above already name a single document; repeating it
              here only pushes what changed further down. */}
          {diff.data.documents.length > 1 && (
            <span className="truncate font-mono text-[11px] text-kumo-subtle">{document.path}</span>
          )}
          {document.fields.map((field: FieldChange) => (
            <div key={field.field} className="flex items-baseline gap-1.5">
              <span className="shrink-0 font-mono text-[11px] text-kumo-default">
                {field.field}
              </span>
              <Side value={field.before} tone="before" />
              <span className="shrink-0 text-[11px] text-kumo-inactive">→</span>
              <Side value={field.after} tone="after" />
            </div>
          ))}
          {document.fields.length === 0 && (
            <span className="font-mono text-[11px] text-kumo-subtle">No field changed value.</span>
          )}
          {document.elided > 0 && (
            <span className="font-mono text-[11px] text-kumo-subtle">
              +{document.elided.toLocaleString('en-US')} more fields
            </span>
          )}
        </div>
      ))}
      {diff.data.elided > 0 && (
        <Text variant="secondary" size="sm">
          +{diff.data.elided.toLocaleString('en-US')} more documents
        </Text>
      )}
    </div>
  )
}

function CommitRow({
  commit,
  database,
  busy,
  onUndo,
  onOpen,
}: {
  commit: LoggedCommit
  database: string
  busy: boolean
  onUndo: () => void
  onOpen: (path: string) => void
}) {
  const blocked = undoBlockedBecause(commit)
  const says = undoSays(commit)
  const [open, setOpen] = useState(false)
  const shown = commit.documents.slice(0, 3)
  return (
    <li className="grid gap-1 rounded-md px-1 py-1.5 hover:bg-kumo-tint">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1 rounded text-left hover:text-kumo-default"
          data-testid={`what-changed-${commit.id}`}
        >
          <CaretRightIcon
            size={11}
            className={`shrink-0 text-kumo-subtle ${open ? 'rotate-90' : ''}`}
          />
          <Text as="span" size="sm">
            {describeCommit(commit)}
          </Text>
        </button>
        {commit.undone && <Badge variant="outline">Undone</Badge>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <Text as="span" variant="secondary" size="sm">
            {relativeTime(commit.commitTime)}
          </Text>
          <Button
            variant="ghost"
            size="xs"
            icon={<ArrowCounterClockwiseIcon />}
            onClick={onUndo}
            loading={busy}
            disabled={Boolean(blocked)}
            title={blocked ?? 'Put these documents back as they were'}
            data-testid={`undo-${commit.id}`}
          >
            {/* What it will do, when it is more than one document: the
                row above this one was "200 created", one unconfirmed
                click from deleting two hundred documents. */}
            {says === undefined ? 'Undo' : `Undo · ${says}`}
          </Button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {shown.map((document) => (
          <button
            key={`${document.database}/${document.path}`}
            type="button"
            onClick={() => onOpen(document.path)}
            className="flex h-5 max-w-full items-center gap-1 rounded bg-kumo-control px-1.5 font-mono text-[11px] text-kumo-default hover:bg-kumo-base"
            title={document.path}
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                document.kind === 'created'
                  ? 'bg-kumo-success'
                  : document.kind === 'deleted'
                    ? 'bg-kumo-danger'
                    : 'bg-kumo-warning'
              }`}
              aria-hidden
            />
            <span className="truncate">{documentName(document.path)}</span>
          </button>
        ))}
        {commit.documents.length > shown.length && (
          <Text as="span" variant="secondary" size="sm">
            +{commit.documents.length - shown.length}
          </Text>
        )}
      </div>
      {open && <Diff database={database} id={commit.id} />}
    </li>
  )
}
