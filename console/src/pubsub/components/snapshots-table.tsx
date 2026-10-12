// A topic's snapshots (S6): each records which messages one of its
// subscriptions had not acknowledged when it was taken. From a row, replay
// that subscription to it, or delete it.

import { ArrowCounterClockwiseIcon, CameraIcon, TrashIcon } from '@phosphor-icons/react'
import { Button } from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { PubsubSnapshot } from '@/api/generated/messaging/PubsubSnapshot'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { EmptyState, QueryError } from '@/components/console/empty-state'
import { RelativeTime } from '@/components/console/relative-time'
import type { RowMenuItem } from '@/components/console/row-menu'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { deleteSnapshot } from '../api'
import { shortName } from '../names'
import { pubsubKeys, snapshotsQuery } from '../queries'

const SNAPSHOT_COLUMNS: readonly DataTableColumn<PubsubSnapshot>[] = [
  { id: 'id', header: 'Snapshot', width: 220, cell: (row) => row.id },
  {
    id: 'source',
    header: 'Source subscription',
    width: 200,
    cell: (row) =>
      row.source ? shortName(row.source) : <span className="text-kumo-inactive">—</span>,
  },
  {
    id: 'created',
    header: 'Created',
    width: 110,
    cell: (row) => <RelativeTime iso={row.createdAt} />,
    copy: (row) => row.createdAt,
  },
  {
    id: 'expires',
    header: 'Expires',
    width: 110,
    cell: (row) => <RelativeTime iso={row.expireTime} />,
    copy: (row) => row.expireTime,
  },
  {
    id: 'unacked',
    header: 'Unacked',
    width: 90,
    align: 'end',
    cell: (row) => formatNumber(row.unacked),
  },
]

/** A topic's snapshots, newest first. */
export function topicSnapshots(
  snapshots: readonly PubsubSnapshot[] | undefined,
  topic: string,
): PubsubSnapshot[] {
  return (snapshots ?? [])
    .filter((snapshot) => snapshot.topic === topic && !snapshot.topicDeleted)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function SnapshotsTable({
  project,
  topic,
  onCreate,
  onReplay,
}: {
  project: string
  /** The topic's full name. */
  topic: string
  onCreate: () => void
  /** Opens the replay of the snapshot's source subscription, with the snapshot chosen. */
  onReplay: (subscription: string, snapshot: string) => void
}) {
  const queryClient = useQueryClient()
  const query = useQuery(snapshotsQuery(project))
  const rows = topicSnapshots(query.data?.items, topic)
  const topicId = shortName(topic)
  const [deleting, setDeleting] = useState<PubsubSnapshot | null>(null)
  const remove = useMutation({
    mutationFn: (snapshot: PubsubSnapshot) => deleteSnapshot({ name: snapshot.name }),
    onSuccess: (_answer, snapshot) => {
      setDeleting(null)
      toast({ key: `pubsub-snapshot-${snapshot.name}`, title: `Deleted ${snapshot.id}` })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.snapshots(project) })
    },
  })

  const rowMenu = (row: PubsubSnapshot): RowMenuItem[] => [
    {
      id: 'replay',
      label: row.source ? `Replay ${shortName(row.source)} to this…` : 'Replay to this…',
      icon: ArrowCounterClockwiseIcon,
      disabled: row.source ? undefined : 'Its source subscription is not known.',
      run: () => row.source && onReplay(row.source, row.name),
    },
    {
      id: 'delete',
      label: 'Delete…',
      icon: TrashIcon,
      danger: true,
      run: () => {
        remove.reset()
        setDeleting(row)
      },
    },
  ]

  if (query.isError)
    return <QueryError error={query.error} onRetry={() => void query.refetch()} section="pubsub" />
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-snapshots">
      <DataTable
        ariaLabel={`Snapshots of ${topicId}`}
        rows={rows}
        rowKey={(row) => row.name}
        columns={SNAPSHOT_COLUMNS}
        memoryKey="pubsub.snapshots"
        rowClick="cursor"
        rowMenu={rowMenu}
        loading={query.isPending}
        empty={
          <EmptyState
            icon={CameraIcon}
            title={`No snapshots of ${topicId}`}
            description="A snapshot records which messages a subscription has not acknowledged, so you can replay to that point later."
            actions={
              <Button variant="secondary" icon={<CameraIcon />} onClick={onCreate}>
                New snapshot
              </Button>
            }
            testId="pubsub-snapshots-empty"
          />
        }
        testId="pubsub-snapshots-table"
      />
      <DangerConfirm
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.id ?? ''}`}
        description="Its subscription can no longer be replayed to this point."
        {...(remove.isError ? { error: remove.error.message } : {})}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        testId="pubsub-snapshot-delete-confirm"
      />
    </div>
  )
}
