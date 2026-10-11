// A column header is a menu: sort by the field, start a filter on it, or
// hide it. Sorting writes the orderBy clause the query line shows, so the
// grid and the query text never disagree.

import { DropdownMenu } from '@cloudflare/kumo'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  ColumnsIcon,
  PushPinSimpleIcon,
  PushPinSimpleSlashIcon,
  EyeSlashIcon,
  FunnelIcon,
  SortAscendingIcon,
  SortDescendingIcon,
  XIcon,
} from '@phosphor-icons/react'
import { MenuCheck, TypeBadge } from '@/components/kit'
import { type InferredColumn, coverage, describeTypes } from '../columns'
import { printQuery } from '../query'
import { useColumns, useQueryLine } from '../query-line-store'
import { useWorkbench } from './workbench-context'

export function HeaderMenu({ column }: { column: InferredColumn }) {
  const workbench = useWorkbench()
  const hide = useColumns((state) => state.hide)
  const compose = useQueryLine((state) => state.compose)
  const sorted = workbench.query.orderBy.find((order) => order.field === column.field)?.direction
  const share = coverage(column)

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
            <TypeBadge
              type={column.type}
              mixed={column.mixed && column.holds ? describeTypes(column.holds) : undefined}
            />
            {/* How much of the page has this field, when not all of it
                does. A column reads as a promise that every row has a
                value, and on a schemaless collection it is not one. */}
            {share !== undefined && (
              <span
                className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums"
                data-testid="column-coverage"
              >
                {share}
              </span>
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
        {/* What the loaded documents actually put in this field. The amber
            dot in the header marks only the case worth marking — two real
            types in one column — but a field that is sometimes null is
            worth being able to find out about, and a tooltip is the wrong
            place for the only explanation of either. */}
        {(column.holds || share !== undefined) && (
          <DropdownMenu.Group>
            <DropdownMenu.Label className="px-2 pt-0.5 pb-1 text-[11px] font-medium tracking-wide text-kumo-subtle">
              {column.mixed ? 'More than one type here' : 'What this column holds'}
            </DropdownMenu.Label>
            {share !== undefined && (
              <div className="px-2 pb-1 text-[12px] text-kumo-default" data-testid="column-present">
                In {column.present.toLocaleString('en-US')} of the{' '}
                {column.of.toLocaleString('en-US')} loaded documents
              </div>
            )}
            {column.holds && (
              <div className="px-2 pb-1.5 font-mono text-[12px] text-kumo-default">
                {describeTypes(column.holds)}
              </div>
            )}
          </DropdownMenu.Group>
        )}
        <DropdownMenu.Item icon={SortAscendingIcon} onClick={() => sortBy('asc')}>
          Sort ascending
          <MenuCheck on={sorted === 'asc'} />
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={SortDescendingIcon} onClick={() => sortBy('desc')}>
          Sort descending
          <MenuCheck on={sorted === 'desc'} />
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

/**
 * The header of the column the rare fields are folded into: how many, and
 * the way back to having them as columns.
 *
 * It says why rather than only how many, because a field that has
 * disappeared from the header row is a field somebody will go looking for.
 */
export function FoldedHeader({ folded }: { folded: readonly InferredColumn[] }) {
  const unfold = useColumns((state) => state.unfold)
  const of = folded[0]?.of ?? 0
  const most = Math.max(...folded.map((column) => column.present))
  const names = folded.slice(0, 6).map((column) => column.field)
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="group flex h-full w-full items-center gap-1.5 rounded px-1 text-left hover:bg-kumo-tint"
            aria-label={`${folded.length} rare fields`}
            data-testid="column-folded"
          >
            <span className="truncate font-mono text-[12px] font-medium text-kumo-subtle">
              +{folded.length.toLocaleString('en-US')} fields
            </span>
            <CaretDownIcon
              size={12}
              className="ml-auto shrink-0 text-kumo-subtle opacity-0 group-hover:opacity-100 group-aria-expanded:opacity-100"
            />
          </button>
        }
      />
      <DropdownMenu.Content align="start">
        <DropdownMenu.Group>
          <DropdownMenu.Label className="px-2 pt-0.5 pb-1 text-[11px] font-medium tracking-wide text-kumo-subtle">
            Rare fields, folded
          </DropdownMenu.Label>
          <div className="max-w-72 px-2 pb-1.5 text-[12px] text-kumo-default">
            {folded.length.toLocaleString('en-US')} fields that{' '}
            {most === 1 ? 'only one' : `${most} or fewer`} of the {of.toLocaleString('en-US')}{' '}
            loaded documents have. Each row lists the ones it has.
          </div>
          <div className="max-w-72 truncate px-2 pb-1.5 font-mono text-[12px] text-kumo-subtle">
            {names.join(', ')}
            {folded.length > names.length ? ', …' : ''}
          </div>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={ColumnsIcon} onClick={unfold} data-testid="unfold-columns">
          Show them as columns
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/**
 * The id column's header, as a menu like every other header's — with the
 * one thing the id column has that a field does not: it can stay put while
 * the fields scroll, or scroll with them.
 */
export function IdHeaderMenu({
  label,
  frozen,
  onFreeze,
}: {
  /** `id`, or `path` in a collection group. */
  label: string
  frozen: boolean
  onFreeze: (frozen: boolean) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="group flex h-full w-full items-center gap-1.5 rounded px-1 text-left hover:bg-kumo-tint"
            aria-label={`${label} column`}
            data-testid="id-header"
          >
            <span className="font-mono text-[12px] font-medium text-kumo-default">{label}</span>
            <TypeBadge type="doc" />
            <CaretDownIcon
              size={12}
              className="ml-auto shrink-0 text-kumo-subtle opacity-0 group-hover:opacity-100 group-aria-expanded:opacity-100"
            />
          </button>
        }
      />
      <DropdownMenu.Content align="start">
        {frozen ? (
          <DropdownMenu.Item
            icon={PushPinSimpleSlashIcon}
            onClick={() => onFreeze(false)}
            data-testid="unfreeze-id"
          >
            Unfreeze column
          </DropdownMenu.Item>
        ) : (
          <DropdownMenu.Item
            icon={PushPinSimpleIcon}
            onClick={() => onFreeze(true)}
            data-testid="freeze-id"
          >
            Freeze column
          </DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
