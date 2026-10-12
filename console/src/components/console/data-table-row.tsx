// One row of a `DataTable`, its own memoized component: the table
// re-renders on every frame of a scroll (the virtualizer lives there), and a
// row that has not changed has no business re-rendering with it. Everything
// a row is given is a value it shows or a ref it calls through, so a scroll
// re-renders only the rows that entered the window.

import { Button, Checkbox, cn } from '@cloudflare/kumo'
import { DotsThreeIcon, SidebarSimpleIcon } from '@phosphor-icons/react'
import { type ReactNode, type RefObject, memo } from 'react'
import { CURSOR, CURSOR_ROW, PIN_CELL, PIN_EDGE, PIN_EDGE_END } from './table-pins'

/** A column as a row draws it: its width settled and, when pinned, where it sticks. */
export interface PlacedColumn<Row> {
  id: string
  header: string
  width: number
  align: 'start' | 'end'
  cell: (row: Row) => ReactNode
  /** `left` of a pinned column; undefined for one that scrolls. */
  left: number | undefined
  /** The last pinned column carries the edge. */
  edge: boolean
}

/** What a row asks of its table. Called through a ref, so it never changes a row's props. */
export interface RowActions<Row> {
  click: (row: Row, key: string, column: string | undefined) => void
  /** The cursor to this cell, opening nothing: a right-click before its menu. */
  focus: (row: Row, key: string, column: string | undefined) => void
  doubleClick: (row: Row) => void
  check: (key: string, checked: boolean, shift: boolean) => void
  open: (row: Row) => void
  /** The ⋯ button or a right-click: the menu, at the button or the pointer. */
  menu: (key: string, anchor: Element | { x: number; y: number }) => void
}

/** The ids the grid's `aria-activedescendant` names. */
export function cellId(base: string, index: number, column: string | undefined): string {
  return column === undefined ? `${base}-r${index}` : `${base}-r${index}-${column}`
}

function DataTableRowView<Row>({
  row,
  rowKey,
  rowIndex,
  zebra,
  idBase,
  columns,
  label,
  check,
  openable,
  menu,
  checked,
  cursor,
  cursorColumn,
  open,
  flash,
  multiselect,
  actions,
}: {
  row: Row
  rowKey: string
  /** 1-based position in the whole list, the header being 1: `aria-rowindex`. */
  rowIndex: number
  /** The odd rows of the whole list carry the zebra ground. */
  zebra: boolean
  idBase: string
  columns: readonly PlacedColumn<Row>[]
  /** The row's name for its controls: "Select u_9f3k2", "Open u_9f3k2". */
  label: string
  check: boolean
  openable: boolean
  menu: boolean
  checked: boolean
  cursor: boolean
  cursorColumn: string | undefined
  open: boolean
  flash: 'created' | 'updated' | 'deleted' | undefined
  multiselect: boolean
  actions: RefObject<RowActions<Row> | null>
}) {
  const lead = check || openable
  return (
    <tr
      id={cellId(idBase, rowIndex, undefined)}
      aria-rowindex={rowIndex}
      aria-selected={multiselect ? checked : undefined}
      data-key={rowKey}
      data-testid="data-row"
      data-cursor={cursor ? '' : undefined}
      className={cn(
        'group/row cursor-default',
        checked
          ? 'bg-kumo-tint [--kumo-table-row-bg:var(--color-kumo-tint)]'
          : zebra
            ? 'bg-kumo-elevated [--kumo-table-row-bg:var(--color-kumo-elevated)]'
            : '[--kumo-table-row-bg:var(--color-kumo-base)]',
        (cursor || open) && CURSOR_ROW,
        flash === 'deleted' ? 'row-flash-deleted' : flash ? 'row-flash' : '',
      )}
      onClick={(event) => {
        const cell = (event.target as HTMLElement).closest('td')
        if (cell?.dataset.check !== undefined || cell?.dataset.menu !== undefined) return
        actions.current?.click(row, rowKey, cell?.dataset.column)
      }}
      onDoubleClick={(event) => {
        const cell = (event.target as HTMLElement).closest('td')
        if (cell?.dataset.check !== undefined || cell?.dataset.menu !== undefined) return
        actions.current?.doubleClick(row)
      }}
      onContextMenu={(event) => {
        if (!menu) return
        event.preventDefault()
        actions.current?.focus(
          row,
          rowKey,
          (event.target as HTMLElement).closest('td')?.dataset.column,
        )
        actions.current?.menu(rowKey, { x: event.clientX, y: event.clientY })
      }}
    >
      {lead && (
        <td
          className={cn(
            PIN_CELL,
            columns.every((column) => !column.edge) && PIN_EDGE,
            '!py-0 !pr-1 !pl-3',
          )}
          style={{ left: 0 }}
          data-check=""
          // Shift on a press is also the browser's "extend the text
          // selection"; the click that ticks the box still arrives.
          onMouseDown={(event) => {
            if (event.shiftKey) event.preventDefault()
          }}
        >
          <span className="flex items-center gap-1">
            {check && (
              <Checkbox
                checked={checked}
                onCheckedChange={(next, details) =>
                  actions.current?.check(
                    rowKey,
                    next,
                    (details?.event as MouseEvent | undefined)?.shiftKey === true,
                  )
                }
                aria-label={`Select ${label}`}
                className="relative before:absolute before:-inset-y-2 before:-right-0.5 before:-left-3 before:content-['']"
              />
            )}
            {openable && (
              // The panel it opens: a window with a pane on its right, filled
              // while this row is the one in it. Shown on hover, on the cursor
              // row and pressed on the open one.
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={
                  open ? (
                    <SidebarSimpleIcon mirrored weight="fill" />
                  ) : (
                    <SidebarSimpleIcon mirrored />
                  )
                }
                aria-label={`Open ${label}`}
                aria-pressed={open}
                title={open ? 'In the panel' : 'Open in the panel'}
                data-testid="open-row"
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation()
                  actions.current?.open(row)
                }}
                className={cn(
                  'shrink-0 focus-visible:opacity-100',
                  open
                    ? '!text-kumo-brand opacity-100'
                    : cn(
                        '!text-kumo-subtle hover:!text-kumo-default',
                        cursor ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100',
                      ),
                )}
              />
            )}
          </span>
        </td>
      )}
      {columns.map((column) => (
        <td
          key={column.id}
          id={cellId(idBase, rowIndex, column.id)}
          role="gridcell"
          data-column={column.id}
          data-cursor={cursorColumn === column.id ? '' : undefined}
          className={cn(
            'font-mono text-[12px] text-kumo-default',
            column.align === 'end' && 'text-right tabular-nums',
            column.left !== undefined && PIN_CELL,
            column.edge && PIN_EDGE,
            cursorColumn === column.id && CURSOR,
          )}
          style={column.left !== undefined ? { left: column.left } : undefined}
        >
          {/* The clip is the content's, not the cell's: a pinned cell draws
              its edge outside its own box, and a clipping cell would cut it. */}
          <div className="overflow-hidden text-ellipsis whitespace-nowrap">{column.cell(row)}</div>
        </td>
      ))}
      {/* Slack: columns keep their width when the inspector opens. */}
      <td aria-hidden />
      <td
        className={cn('sticky right-0 z-[1] bg-(--kumo-table-row-bg) !px-1 !py-0', PIN_EDGE_END)}
        data-menu=""
      >
        {menu && (
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<DotsThreeIcon weight="bold" />}
            aria-label={`Actions for ${label}`}
            aria-haspopup="menu"
            tabIndex={-1}
            data-testid="row-menu-button"
            data-row-menu=""
            onClick={(event) => {
              event.stopPropagation()
              actions.current?.menu(rowKey, event.currentTarget)
            }}
            className={cn(
              'shrink-0 !text-kumo-subtle hover:!text-kumo-default focus-visible:opacity-100',
              cursor || open ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100',
            )}
          />
        )}
      </td>
    </tr>
  )
}

export const DataTableRow = memo(DataTableRowView) as typeof DataTableRowView
