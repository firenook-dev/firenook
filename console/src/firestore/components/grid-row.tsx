// One document as a row of the grid.
//
// Its own memoized component, because the grid re-renders on every frame
// of a scroll — the virtualizers live there — and a row that has not
// changed has no business re-rendering with it. Everything a row is given
// is either a value it shows or a ref it calls through, so a scroll that
// only moves the window over the rows re-renders the rows that entered it.

import { Button, Checkbox, Table } from '@cloudflare/kumo'
import { SidebarSimpleIcon, WarningIcon } from '@phosphor-icons/react'
import { memo } from 'react'
import type { ChangeKind } from '@/api/generated/ChangeKind'
import { CHECK_WIDTH, CURSOR, PIN_CELL, PIN_EDGE } from '@/components/console/table-pins'
import type { InferredColumn } from '../columns'
import type { SchemaNode } from '../schema'
import type { FsDocument } from '../value'
import { IdCell, ValueCell } from './cells'
import { SubcollectionsCell } from './subcollections-cell'

export const ID_COLUMN = '__name__'
/** The key of the column the rare fields are folded into. */
export const FOLDED_COLUMN = '__folded__'

export type GridColumn =
  | { key: string; kind: 'field'; column: InferredColumn; width: number }
  | {
      key: typeof FOLDED_COLUMN
      kind: 'folded'
      folded: InferredColumn[]
      fields: ReadonlySet<string>
      width: number
    }

/** What a row asks the grid to do. Called through a ref, so it never changes a row's props. */
export interface RowActions {
  click: (document: FsDocument, cell: HTMLTableCellElement | null) => void
  /** The open button: the document into the panel, or out of it again. */
  open: (document: FsDocument) => void
  check: (document: FsDocument, index: number, checked: boolean, shift: boolean) => void
  edit: (document: FsDocument, field: string) => void
  openReference: (path: string) => void
}

// The pinned id, its edge and the cursor cell are the console's table pins
// (`components/console/table-pins.ts`): every table in the console marks
// them the same way.

export const GridRow = memo(function GridRow({
  document,
  index,
  cells,
  before,
  after,
  subcolumn,
  known,
  group,
  checked,
  focused,
  open,
  frozen,
  cursor,
  flash,
  actions,
}: {
  document: FsDocument
  index: number
  cells: readonly GridColumn[]
  /** Columns scrolled out of the window on either side, drawn as one spacer each. */
  before: boolean
  after: boolean
  subcolumn: boolean
  known: readonly SchemaNode[]
  group: boolean
  checked: boolean
  focused: boolean
  /** This document is the one open in the panel. */
  open: boolean
  /** The id stays put while the fields scroll; unfrozen, only the box does. */
  frozen: boolean
  /** The column the keyboard is on, when it is on this row. */
  cursor: string | undefined
  flash: ChangeKind | undefined
  actions: React.RefObject<RowActions | null>
}) {
  const openReference = (path: string) => actions.current?.openReference(path)
  return (
    <Table.Row
      data-index={index}
      data-path={document.path}
      variant={checked ? 'selected' : 'default'}
      className={`group/row cursor-default ${
        focused || open
          ? 'bg-kumo-tint [--kumo-table-row-bg:var(--color-kumo-tint)] [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-kumo-brand)]'
          : ''
      } ${flash ? (flash === 'deleted' ? 'row-flash-deleted' : 'row-flash') : ''}`}
      onClick={(event) =>
        actions.current?.click(document, (event.target as HTMLElement).closest('td'))
      }
      data-testid="grid-row"
    >
      <Table.Cell
        className={`${PIN_CELL} ${frozen ? '' : PIN_EDGE} !py-0 !pr-1 !pl-3`}
        style={{ left: 0 }}
        data-check=""
        // Shift on a press is also the browser's own "extend the text
        // selection". The grid's text cannot be selected, but a selection
        // begun outside it — a name in the inspector — would still run
        // from there to the box across everything between. The click that
        // ticks the box still arrives.
        onMouseDown={(event) => {
          if (event.shiftKey) event.preventDefault()
        }}
      >
        <span className="flex items-center gap-1">
          <Checkbox
            checked={checked}
            onCheckedChange={(next, details) =>
              actions.current?.check(
                document,
                index,
                next,
                (details?.event as MouseEvent | undefined)?.shiftKey === true,
              )
            }
            aria-label={`Select ${document.id}`}
            className="relative before:absolute before:-inset-y-2 before:-right-0.5 before:-left-3 before:content-['']"
          />
          {/* The one way into the panel by pointer. A click on a cell is
              the cell's — the cursor lands there, ready to copy or edit —
              and opening a 400-pixel panel on every one of them took
              forty per cent of the grid away to answer a click that only
              meant "this one". Shown on hover, on the row being worked
              on, and pressed on the row the panel holds. Kumo's own ghost
              button, as the path's copy is, so it hovers and names itself
              the way every other icon button does — it was a bare button
              with a browser tooltip and a hover of its own.
              The glyph is the panel it opens: a window with a pane on its
              right, filled while this row is the one in it. It was the
              diagonal "expand" arrows, which say maximise, and which the
              field rows already use for putting a value in a box. */}
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={
              open ? <SidebarSimpleIcon mirrored weight="fill" /> : <SidebarSimpleIcon mirrored />
            }
            aria-label={`Open ${document.id}`}
            aria-pressed={open}
            title={open ? 'Close the panel' : 'Open in the panel'}
            data-testid="open-row"
            onClick={(event) => {
              event.stopPropagation()
              actions.current?.open(document)
            }}
            className={`shrink-0 focus-visible:opacity-100 ${
              open
                ? '!text-kumo-brand opacity-100'
                : `!text-kumo-subtle hover:!text-kumo-default ${focused ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'}`
            }`}
          />
        </span>
      </Table.Cell>
      <Table.Cell
        className={frozen ? `${PIN_CELL} ${PIN_EDGE}` : undefined}
        style={frozen ? { left: CHECK_WIDTH } : undefined}
        data-field={ID_COLUMN}
      >
        <span className="flex items-center gap-1.5">
          {document.missing && (
            <span
              className="flex h-lh items-center text-kumo-subtle"
              title="No document here, only subcollections"
            >
              <WarningIcon size={14} />
            </span>
          )}
          <IdCell id={group ? document.path : document.id} missing={document.missing} />
        </span>
      </Table.Cell>
      {subcolumn && (
        <Table.Cell className="!px-2">
          <SubcollectionsCell path={document.path} known={known} />
        </Table.Cell>
      )}
      {before && <Table.Cell aria-hidden />}
      {cells.map((cell) => {
        if (cell.kind === 'folded')
          return (
            <Table.Cell
              key={cell.key}
              data-field={cell.key}
              data-testid="cell-folded"
              data-cursor={cursor === cell.key ? '' : undefined}
              className={cursor === cell.key ? CURSOR : ''}
            >
              {!document.missing && <FoldedCell document={document} fields={cell.fields} />}
            </Table.Cell>
          )
        const { column } = cell
        const value = document.fields[column.field]
        // A value whose type differs from the column's is the odd one out —
        // but only in a column that holds two real types. An unset field is
        // written `null` on purpose, and tinting every one of those marks
        // ordinary data as a fault; the muted `null` in the cell already
        // says it.
        const odd =
          column.mixed === true &&
          value !== undefined &&
          value.type !== 'null' &&
          value.type !== column.type
        return (
          <Table.Cell
            key={cell.key}
            data-field={cell.key}
            data-testid={`cell-${column.field}`}
            data-cursor={cursor === cell.key ? '' : undefined}
            className={`${odd ? 'bg-kumo-warning-tint' : ''} ${cursor === cell.key ? CURSOR : ''}`}
            title={odd ? `${value.type}, where most documents have ${column.type}` : undefined}
            onDoubleClick={(event) => {
              if (document.missing) return
              event.preventDefault()
              event.stopPropagation()
              actions.current?.edit(document, column.field)
            }}
          >
            {/* A placeholder for a missing ancestor is not a document, so it
                has no fields to be missing: its cells say nothing at all. */}
            {!document.missing && <ValueCell value={value} onOpenReference={openReference} />}
          </Table.Cell>
        )
      })}
      {after && <Table.Cell aria-hidden />}
      <Table.Cell aria-hidden />
    </Table.Row>
  )
})

/**
 * The rare fields this document has, named the way a map cell names its
 * keys. A row with none of them says nothing.
 */
function FoldedCell({ document, fields }: { document: FsDocument; fields: ReadonlySet<string> }) {
  const names: string[] = []
  for (const field of Object.keys(document.fields)) if (fields.has(field)) names.push(field)
  if (names.length === 0) return null
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={names.slice(0, 24).join(', ')}>
      <span className="shrink-0 rounded bg-kumo-tint px-1 font-mono text-[11px] text-kumo-subtle tabular-nums">
        +{names.length}
      </span>
      <span className="truncate font-mono text-[12px] text-kumo-subtle">
        {names.slice(0, 8).join(', ')}
      </span>
    </span>
  )
}
