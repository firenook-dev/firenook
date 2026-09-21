// A document that has subcollections says so in the grid: a small chip after
// its id, listing them with their counts and jumping straight in. Only the
// rows on screen ask (the grid is virtualized), and the answer is cached and
// kept fresh by the live channel.

import { DropdownMenu } from '@cloudflare/kumo'
import { FolderIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { EMPTY_QUERY } from '../query'
import { collectionsQuery, countQueryOptions } from '../queries'
import { formatNumber } from '../value'
import { useWorkbench } from './workbench-context'

export function SubcollectionsChip({ path }: { path: string }) {
  const workbench = useWorkbench()
  const subcollections = useQuery({
    ...collectionsQuery(workbench.ownerScope, path),
    staleTime: 60_000,
  })
  const ids = subcollections.data ?? []
  if (ids.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="flex h-5 shrink-0 items-center gap-1 rounded bg-kumo-tint px-1 font-mono text-[11px] text-kumo-subtle tabular-nums hover:bg-kumo-elevated hover:text-kumo-default"
            title={`Subcollections: ${ids.join(', ')}`}
            aria-label={`${ids.length} subcollection${ids.length === 1 ? '' : 's'} under ${path}`}
            data-testid="subcollections-chip"
          >
            <FolderIcon size={12} />
            {ids.length}
          </button>
        }
      />
      <DropdownMenu.Content align="start">
        <DropdownMenu.Group>
          <DropdownMenu.Label>
            <span className="font-mono text-[11px]">{path}</span>
          </DropdownMenu.Label>
        </DropdownMenu.Group>
        {ids.map((id) => (
          <DropdownMenu.Item
            key={id}
            icon={FolderIcon}
            onClick={(event) => {
              // The menu is portaled, but React still bubbles to the row.
              event.stopPropagation()
              workbench.setPath(`${path}/${id}`)
            }}
          >
            <span className="flex flex-1 items-center gap-3">
              <span className="font-mono text-[12px]">{id}</span>
              <span className="ml-auto font-mono text-[11px] text-kumo-subtle tabular-nums">
                <ChipCount path={`${path}/${id}`} />
              </span>
            </span>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

function ChipCount({ path }: { path: string }) {
  const workbench = useWorkbench()
  const count = useQuery(countQueryOptions(workbench.ownerScope, path, false, EMPTY_QUERY))
  return count.data ? formatNumber(count.data.count) : null
}
