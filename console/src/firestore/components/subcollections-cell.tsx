// A document's subcollections, named, in their own grid column: `orders 5 ·
// sessions 2`, each a link straight into it. The schema says which
// subcollections the collection's documents can have (that is what sizes
// the column); each rendered row asks the engine which ones it actually has,
// cached and kept fresh by the live channel. When a row has more than fit,
// the rest are a menu.

import { DropdownMenu } from '@cloudflare/kumo'
import { DotsThreeIcon, FolderIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { EMPTY_QUERY } from '../query'
import { collectionsQuery, countQueryOptions } from '../queries'
import type { SchemaNode } from '../schema'
import { formatNumber } from '../value'
import { useWorkbench } from './workbench-context'

/** Chips shown inline before the rest fold into a menu. */
const INLINE = 3

/** The column's width for the subcollections the schema knows, px. */
export function subcollectionsWidth(known: readonly SchemaNode[]): number {
  const chips = known.slice(0, INLINE)
  const text = chips.reduce((sum, node) => sum + node.id.length * 7.2 + 46, 0)
  return Math.round(Math.min(400, Math.max(140, text + 24)))
}

export function SubcollectionsCell({
  path,
  known,
}: {
  path: string
  known: readonly SchemaNode[]
}) {
  const workbench = useWorkbench()
  const subcollections = useQuery({
    ...collectionsQuery(workbench.ownerScope, path),
    staleTime: 60_000,
  })
  const ids = subcollections.data ?? []
  if (ids.length === 0) return null
  // The schema's order first, so chips line up down the column.
  const order = new Map(known.map((node, index) => [node.id, index]))
  const sorted = ids.toSorted(
    (a, b) => (order.get(a) ?? known.length) - (order.get(b) ?? known.length) || a.localeCompare(b),
  )
  const inline = sorted.slice(0, INLINE)
  const rest = sorted.slice(INLINE)
  return (
    <span className="flex min-w-0 items-center gap-1" data-testid="subcollections-chip">
      {inline.map((id) => (
        <button
          key={id}
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            workbench.setPath(`${path}/${id}`)
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          className="flex h-5 min-w-0 shrink items-center gap-1 rounded bg-kumo-tint pr-1.5 pl-1 font-mono text-[11px] text-kumo-default hover:bg-kumo-elevated"
          title={`Open ${path}/${id}`}
          data-testid="subcollection-link"
          data-id={id}
        >
          <FolderIcon size={11} className="shrink-0 text-kumo-subtle" />
          <span className="truncate">{id}</span>
          <span className="shrink-0 text-kumo-subtle tabular-nums">
            <ChipCount path={`${path}/${id}`} />
          </span>
        </button>
      ))}
      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                type="button"
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                className="flex h-5 shrink-0 items-center gap-0.5 rounded bg-kumo-tint px-1 font-mono text-[11px] text-kumo-subtle tabular-nums hover:bg-kumo-elevated hover:text-kumo-default"
                title={`${rest.length} more: ${rest.join(', ')}`}
                aria-label={`${rest.length} more subcollections under ${path}`}
                data-testid="subcollections-more"
              >
                <DotsThreeIcon size={12} weight="bold" />
                {rest.length}
              </button>
            }
          />
          <DropdownMenu.Content align="start">
            <DropdownMenu.Group>
              <DropdownMenu.Label>
                <span className="font-mono text-[11px]">{path}</span>
              </DropdownMenu.Label>
            </DropdownMenu.Group>
            {rest.map((id) => (
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
      )}
    </span>
  )
}

function ChipCount({ path }: { path: string }) {
  const workbench = useWorkbench()
  const count = useQuery(countQueryOptions(workbench.ownerScope, path, false, EMPTY_QUERY))
  return count.data ? formatNumber(count.data.count) : null
}
