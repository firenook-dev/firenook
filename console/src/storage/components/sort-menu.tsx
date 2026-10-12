// The listing's order, in the engine: by name (the fast path, patched live),
// by size (what is eating space), by last change (what just happened) or by
// type. Only the columns `GET /storage/objects/meta` says sort are offered.
// The header of the list sorts too; both write `sort=<column>:<dir>`.

import { Button, DropdownMenu } from '@cloudflare/kumo'
import { CaretDownIcon, SortAscendingIcon, SortDescendingIcon } from '@phosphor-icons/react'
import { MenuCheck } from '@/components/kit'
import { useFiles } from '../files-state'
import { SORT_COLUMNS, type SortColumn, sortOf } from '../search'

export const SORT_LABELS: Record<SortColumn, string> = {
  name: 'Name',
  size: 'Size',
  updated: 'Last changed',
  type: 'Type',
}

export function SortMenu({ sortable }: { sortable: readonly string[] | undefined }) {
  const files = useFiles()
  const { column, direction } = sortOf(files.sort)
  const columns = SORT_COLUMNS.filter((name) => sortable === undefined || sortable.includes(name))
  const write = (next: { column: SortColumn; direction: 'asc' | 'desc' }) =>
    files.update({ sort: `${next.column}:${next.direction}` }, { replace: true })
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            icon={direction === 'asc' ? <SortAscendingIcon /> : <SortDescendingIcon />}
            aria-label={`Order: ${SORT_LABELS[column]}, ${direction === 'asc' ? 'ascending' : 'descending'}`}
            className="shrink-0"
            data-testid="sort-menu"
          >
            <span className="flex items-center gap-1 text-[12px]">
              {SORT_LABELS[column]} {direction === 'asc' ? '↑' : '↓'}
              <CaretDownIcon size={12} className="text-kumo-subtle" />
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Group>
          <DropdownMenu.Label className="px-2 pt-0.5 pb-1 text-[11px] font-medium text-kumo-subtle">
            Order by
          </DropdownMenu.Label>
          {columns.map((name) => (
            <DropdownMenu.Item
              key={name}
              onClick={() =>
                write({
                  column: name,
                  // Sizes and times are most often wanted biggest and newest first.
                  direction:
                    name === column
                      ? direction
                      : name === 'size' || name === 'updated'
                        ? 'desc'
                        : 'asc',
                })
              }
              data-testid={`sort-${name}`}
            >
              {SORT_LABELS[name]}
              <MenuCheck on={name === column} />
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onClick={() => write({ column, direction: 'asc' })}>
          Ascending
          <MenuCheck on={direction === 'asc'} />
        </DropdownMenu.Item>
        <DropdownMenu.Item onClick={() => write({ column, direction: 'desc' })}>
          Descending
          <MenuCheck on={direction === 'desc'} />
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
