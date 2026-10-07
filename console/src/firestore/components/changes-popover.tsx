// Recent changes, and putting one back.
//
// It hangs off the live indicator, because "3 changes" invites exactly one
// question. Every write the emulator accepted is here — the console's own,
// the app's, a trigger's — newest first, each with the documents it touched
// and an undo that restores the exact documents it replaced.

import { Badge, Button, Popover, Text, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { LiveDot, type LiveState } from '@/components/kit'
import { ApiError } from '@/api/client'
import {
  type LoggedCommit,
  changeLogQuery,
  describeCommit,
  lastSegment,
  undoBlockedBecause,
  undoCommit,
} from '../changelog'
import { relativeTime } from '../value'
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
            <LiveDot state={state} changes={changes} />
          </button>
        }
      />
      <Popover.Content className="w-[440px] max-w-[calc(100vw-2rem)]">
        {/* Kumo's Popover.Content drops unknown props, so the test id and
            the layout live on a div of our own inside it. */}
        <div className="grid gap-2" data-testid="changes-popover">
          <div className="flex items-baseline justify-between gap-3">
            <Text variant="heading" as="h3">
              Recent changes
            </Text>
            {log.data && log.data.retained > 0 && (
              <Text variant="secondary" size="sm">
                {log.data.retained.toLocaleString('en-US')} kept
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

function CommitRow({
  commit,
  busy,
  onUndo,
  onOpen,
}: {
  commit: LoggedCommit
  busy: boolean
  onUndo: () => void
  onOpen: (path: string) => void
}) {
  const blocked = undoBlockedBecause(commit)
  const shown = commit.documents.slice(0, 3)
  return (
    <li className="grid gap-1 rounded-md px-1 py-1.5 hover:bg-kumo-tint">
      <div className="flex items-center gap-2">
        <Text as="span" size="sm">
          {describeCommit(commit)}
        </Text>
        {commit.undone && <Badge variant="outline">undone</Badge>}
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
            Undo
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
            <span className="truncate">{lastSegment(document.path)}</span>
          </button>
        ))}
        {commit.documents.length > shown.length && (
          <Text as="span" variant="secondary" size="sm">
            +{commit.documents.length - shown.length}
          </Text>
        )}
      </div>
    </li>
  )
}
