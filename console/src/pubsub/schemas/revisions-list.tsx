// A schema's revisions (PS-52) and the topics that use it (PS-54).
//
// Revisions, newest first: each one viewed read-only in the editor's
// place, diffed against the editor, rolled back to (the engine makes a new
// revision with its definition, so nothing is lost), or deleted — except
// the only one left, which the engine refuses in its own words. Used by:
// each topic bound to the schema, how it encodes, which revisions it
// accepts and the one it checks publishes against.

import {
  ArrowCounterClockwiseIcon,
  BroadcastIcon,
  ClockCounterClockwiseIcon,
  GitDiffIcon,
  SidebarSimpleIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { PubsubSchemaDetail } from '@/api/generated/messaging/PubsubSchemaDetail'
import type { PubsubSchemaRevision } from '@/api/generated/messaging/PubsubSchemaRevision'
import type { PubsubSchemaUse } from '@/api/generated/messaging/PubsubSchemaUse'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { EmptyState } from '@/components/console/empty-state'
import { EntityLink } from '@/components/console/entity-link'
import { RelativeTime } from '@/components/console/relative-time'
import type { RowMenuItem } from '@/components/console/row-menu'
import { toast } from '@/lib/toasts'
import { errorText } from '@/lib/error-text'
import { deleteSchemaRevision } from '../api'
import { shortName } from '../names'
import { pubsubKeys } from '../queries'
import { normalDefinition, revisionLabel } from './schema-text'

/** What the engine answers when the only revision is deleted; said before it is asked. */
export const LAST_REVISION = 'Cannot delete last revision. Please use DeleteSchema.'

/** A revision as a row: its place in the list (1 = the first made) rides along. */
interface RevisionRow extends PubsubSchemaRevision {
  index: number
  latest: boolean
}

const REVISION_COLUMNS: readonly DataTableColumn<RevisionRow>[] = [
  {
    id: 'revision',
    header: 'Revision',
    width: 140,
    cell: (row) => (
      <span className="inline-flex items-center gap-2 align-middle">
        {revisionLabel(row.id)}
        {row.latest && (
          <span className="rounded bg-kumo-tint px-1 font-sans text-[11px] text-kumo-subtle">
            latest
          </span>
        )}
      </span>
    ),
    copy: (row) => row.id,
  },
  {
    id: 'number',
    header: '#',
    width: 56,
    align: 'end',
    cell: (row) => String(row.index),
  },
  {
    id: 'created',
    header: 'Created',
    width: 110,
    cell: (row) => <RelativeTime iso={row.createdAt} />,
    copy: (row) => row.createdAt,
  },
  {
    id: 'definition',
    header: 'Definition',
    width: 480,
    cell: (row) => <span className="text-kumo-subtle">{normalDefinition(row.definition)}</span>,
    copy: (row) => row.definition,
  },
]

export function RevisionsList({
  project,
  detail,
  current,
  onView,
  onDiff,
  onRollback,
}: {
  project: string
  detail: PubsubSchemaDetail
  /** The revision open in the editor's place, if any. */
  current: string | undefined
  onView: (revision: string) => void
  onDiff: (revision: string) => void
  onRollback: (revision: PubsubSchemaRevision) => void
}) {
  const queryClient = useQueryClient()
  const latest = detail.revisions.at(-1)?.id
  const rows: RevisionRow[] = detail.revisions
    .map((revision, index) => ({ ...revision, index: index + 1, latest: revision.id === latest }))
    .toReversed()
  const only = detail.revisions.length === 1
  const [deleting, setDeleting] = useState<RevisionRow | null>(null)
  const remove = useMutation({
    mutationFn: (row: RevisionRow) => deleteSchemaRevision({ name: detail.name, revision: row.id }),
    onSuccess: (answer, row) => {
      setDeleting(null)
      queryClient.setQueryData(pubsubKeys.schema(project, detail.name), answer)
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.schemas(project) })
      toast({
        key: `pubsub-revision-${row.id}`,
        title: `Deleted revision ${revisionLabel(row.id)}`,
      })
    },
  })

  const rowMenu = (row: RevisionRow): RowMenuItem[] => [
    {
      id: 'view',
      label: row.latest ? 'Open in the editor' : 'View',
      icon: SidebarSimpleIcon,
      shortcut: 'Enter',
      run: () => onView(row.id),
    },
    {
      id: 'diff',
      label: 'Diff with the editor',
      icon: GitDiffIcon,
      run: () => onDiff(row.id),
    },
    {
      id: 'rollback',
      label: 'Roll back to this',
      icon: ArrowCounterClockwiseIcon,
      disabled: row.latest ? 'It is the latest revision.' : undefined,
      run: () => onRollback(row),
    },
    {
      id: 'delete',
      label: 'Delete…',
      icon: TrashIcon,
      danger: true,
      disabled: only ? LAST_REVISION : undefined,
      run: () => {
        remove.reset()
        setDeleting(row)
      },
    },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-schema-revisions">
      <DataTable
        ariaLabel={`Revisions of ${detail.id}`}
        rows={rows}
        rowKey={(row) => row.id}
        columns={REVISION_COLUMNS}
        memoryKey="pubsub.schema-revisions"
        openKey={current}
        onOpen={(row) => onView(row.id)}
        rowClick="open"
        rowMenu={rowMenu}
        empty={
          <EmptyState
            icon={ClockCounterClockwiseIcon}
            title="No revisions"
            testId="pubsub-schema-revisions-empty"
          />
        }
        testId="pubsub-schema-revisions-table"
      />
      <DangerConfirm
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete revision ${deleting ? revisionLabel(deleting.id) : ''}`}
        description={
          <>
            It leaves <span className="font-mono text-[0.9em]">{detail.id}</span>’s history; the
            other revisions stay.
          </>
        }
        consequences={[
          deleting?.latest
            ? 'It is the latest: the one before it becomes the latest, and topics bound to the latest check publishes against that.'
            : 'Topics whose revision window names it keep their window; a publish checked against it is refused.',
        ]}
        {...(remove.isError ? { error: errorText(remove.error) } : {})}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        testId="pubsub-revision-delete-confirm"
      />
    </div>
  )
}

const USE_COLUMNS: readonly DataTableColumn<PubsubSchemaUse>[] = [
  {
    id: 'topic',
    header: 'Topic',
    width: 240,
    cell: (row) => (
      <EntityLink entity={{ kind: 'pubsub.topic', key: row.topic, label: shortName(row.topic) }} />
    ),
    copy: (row) => row.topic,
  },
  {
    id: 'encoding',
    header: 'Encoding',
    width: 96,
    cell: (row) => (
      <span className="font-sans">{row.encoding === 'BINARY' ? 'binary' : 'JSON'}</span>
    ),
    copy: (row) => row.encoding,
  },
  {
    id: 'window',
    header: 'Revisions accepted',
    width: 220,
    cell: (row) => revisionWindow(row),
    copy: (row) => revisionWindow(row),
  },
  {
    id: 'bound',
    header: 'Checks against',
    width: 140,
    cell: (row) => revisionLabel(row.boundRevisionId),
    copy: (row) => row.boundRevisionId,
  },
]

/** "3f2a91c0 – 7b10e4d2", "from 3f2a91c0", "up to 7b10e4d2", "any". */
export function revisionWindow(use: Pick<PubsubSchemaUse, 'firstRevisionId' | 'lastRevisionId'>) {
  const first = use.firstRevisionId ? revisionLabel(use.firstRevisionId) : undefined
  const last = use.lastRevisionId ? revisionLabel(use.lastRevisionId) : undefined
  if (first && last) return `${first} – ${last}`
  if (first) return `from ${first}`
  if (last) return `up to ${last}`
  return 'any'
}

export function UsedByList({ detail }: { detail: PubsubSchemaDetail }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-schema-used-by">
      <DataTable
        ariaLabel={`Topics that use ${detail.id}`}
        rows={detail.usedBy}
        rowKey={(row) => row.topic}
        columns={USE_COLUMNS}
        memoryKey="pubsub.schema-used-by"
        rowClick="cursor"
        empty={
          <EmptyState
            icon={BroadcastIcon}
            title={`No topic uses ${detail.id}`}
            description="Bind it when you create a topic, or in a topic’s Settings: the topic then refuses messages that do not match it."
            testId="pubsub-schema-used-by-empty"
          />
        }
        testId="pubsub-schema-used-by-table"
      />
    </div>
  )
}
