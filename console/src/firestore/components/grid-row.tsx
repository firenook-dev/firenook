// One document as a row of the grid.
//
// Its own memoized component, because the grid re-renders on every frame
// of a scroll — the virtualizers live there — and a row that has not
// changed has no business re-rendering with it. Everything a row is given
// is either a value it shows or a ref it calls through, so a scroll that
// only moves the window over the rows re-renders the rows that entered it.

import { Table } from '@cloudflare/kumo'
import { WarningIcon } from '@phosphor-icons/react'
import { memo } from 'react'
import type { ChangeKind } from '@/api/generated/ChangeKind'
import type { InferredColumn } from '../columns'
import type { SchemaNode } from '../schema'
import type { FsDocument } from '../value'
import { IdCell, ValueCell } from './cells'
import { SubcollectionsCell } from './subcollections-cell'

export const CHECK_WIDTH = 44
/** The id column's key wherever columns are keyed. Firestore reserves `__…__`. */
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
  check: (document: FsDocument, index: number, checked: boolean, shift: boolean) => void
  edit: (document: FsDocument, field: string) => void
  openReference: (path: string) => void
}

/**
 * The id stays put while the fields scroll under it. It used to scroll away
 * with them: 800 px to the right and the column saying which document a
 * row is had gone 296 px off the left edge, so every value on screen was a
 * value of nobody in particular.
 *
 * The ground is the row's own, through the variable Kumo's rows set, so a
 * pinned cell is opaque in every state a row can be in.
 */
export const PIN_CELL = 'sticky z-[1] bg-(--kumo-table-row-bg)'
export const PIN_HEAD = 'sticky z-[2] bg-kumo-elevated'
/**
 * The pinned edge, drawn only once something has scrolled under it. At
 * rest there is nothing under the id to separate it from, and a shadow
 * there would be a line through the first field.
 */
export const PIN_EDGE =
  'group-data-[scrolled]/grid:shadow-[6px_0_6px_-6px_color-mix(in_srgb,var(--text-color-kumo-default)_35%,transparent)]'

/** The cell the keyboard is on: the console's accent, inside the cell, so nothing moves. */
const CURSOR = 'shadow-[inset_0_0_0_1.5px_var(--color-kumo-brand)]'

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
      className={`cursor-default ${
        focused
          ? 'bg-kumo-tint [--kumo-table-row-bg:var(--color-kumo-tint)] [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-kumo-brand)]'
          : ''
      } ${flash ? (flash === 'deleted' ? 'row-flash-deleted' : 'row-flash') : ''}`}
      onClick={(event) =>
        actions.current?.click(document, (event.target as HTMLElement).closest('td'))
      }
      data-testid="grid-row"
    >
      <Table.CheckCell
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
        className={PIN_CELL}
        style={{ left: 0 }}
        data-check=""
      />
      <Table.Cell
        className={`${PIN_CELL} ${PIN_EDGE}`}
        style={{ left: CHECK_WIDTH }}
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
