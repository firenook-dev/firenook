// A column header is a menu: sort by the field, start a filter on it, or
// hide it. Sorting writes the orderBy clause the query line shows, so the
// grid and the query text never disagree.

import { Badge, DropdownMenu } from '@cloudflare/kumo'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  EyeSlashIcon,
  FunnelIcon,
  SortAscendingIcon,
  SortDescendingIcon,
  XIcon,
} from '@phosphor-icons/react'
import { TypeBadge } from '@/components/kit'
import type { InferredColumn } from '../columns'
import { printQuery } from '../query'
import { useColumns, useQueryLine } from '../query-line-store'
import { useWorkbench } from './workbench-context'

export function HeaderMenu({ column }: { column: InferredColumn }) {
  const workbench = useWorkbench()
  const hide = useColumns((state) => state.hide)
  const compose = useQueryLine((state) => state.compose)
  const sorted = workbench.query.orderBy.find((order) => order.field === column.field)?.direction

  const sortBy = (direction: 'asc' | 'desc') =>
    workbench.setQuery({ ...workbench.query, orderBy: [{ field: column.field, direction }] })
  const clearSort = () =>
    workbench.setQuery({
      ...workbench.query,
      orderBy: workbench.query.orderBy.filter((order) => order.field !== column.field),
    })
  const filterBy = () => {
    const current = printQuery(workbench.query)
    const clause = `where(${JSON.stringify(column.field)}, "==", )`
    const text = current ? `${current}.${clause}` : clause
    // The caret lands where the value goes.
    compose(text, text.length - 1)
  }

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="group flex h-full w-full items-center gap-1.5 rounded px-1 text-left hover:bg-kumo-tint"
            aria-label={`${column.field} column`}
            data-testid={`column-${column.field}`}
          >
            <span
              className="truncate font-mono text-[12px] font-medium text-kumo-default"
              title={column.field}
            >
              {column.field}
            </span>
            {column.mixed ? (
              <span
                className="flex items-center"
                title={`Mixed types: ${Object.entries(column.mixed)
                  .map(([name, count]) => `${name} ×${count}`)
                  .join(', ')}`}
              >
                <Badge variant="warning" appearance="dot" className="text-[10px]">
                  {column.type}
                </Badge>
              </span>
            ) : (
              <TypeBadge type={column.type} />
            )}
            {sorted === 'asc' && <ArrowUpIcon size={12} className="shrink-0 text-kumo-brand" />}
            {sorted === 'desc' && <ArrowDownIcon size={12} className="shrink-0 text-kumo-brand" />}
            <CaretDownIcon
              size={12}
              className="ml-auto shrink-0 text-kumo-subtle opacity-0 group-hover:opacity-100 group-aria-expanded:opacity-100"
            />
          </button>
        }
      />
      <DropdownMenu.Content align="start">
        <DropdownMenu.Item
          icon={SortAscendingIcon}
          selected={sorted === 'asc'}
          onClick={() => sortBy('asc')}
        >
          Sort ascending
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={SortDescendingIcon}
          selected={sorted === 'desc'}
          onClick={() => sortBy('desc')}
        >
          Sort descending
        </DropdownMenu.Item>
        {sorted && (
          <DropdownMenu.Item icon={XIcon} onClick={clearSort}>
            Clear sort
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={FunnelIcon} onClick={filterBy}>
          <span className="flex items-center gap-2">
            Filter by <span className="font-mono text-[12px]">{column.field}</span>
          </span>
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={EyeSlashIcon} onClick={() => hide(column.field)}>
          Hide column
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
