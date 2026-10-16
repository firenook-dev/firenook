// The topics that use a schema (PS-54): each topic bound to it, how it
// encodes, which revisions it accepts and the one it checks publishes
// against.

import { BroadcastIcon } from '@phosphor-icons/react'
import type { PubsubSchemaDetail } from '@/api/generated/messaging/PubsubSchemaDetail'
import type { PubsubSchemaUse } from '@/api/generated/messaging/PubsubSchemaUse'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { EmptyState } from '@/components/console/empty-state'
import { EntityLink } from '@/components/console/entity-link'
import { shortName } from '../names'
import { revisionLabel } from './schema-text'

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
