// The measured classes every table in the console shares: the Firestore grid
// and every section's `DataTable` pin, size and mark their cells with these,
// so a table in Auth or Storage cannot drift a pixel from the one in
// Firestore.

/**
 * A row's height, px, and the virtualizer's estimate of it — which have to
 * be the same number. They were not once: rows were `h-9`, which is 2.25 rem
 * and so 31.5 px on this console's 14 px root, while the virtualizer placed
 * them at 36, and every spacer and every scroll-to-row was worked out on a
 * height no row had.
 */
export const ROW_HEIGHT = 32

/**
 * The box and the way into the row, side by side: the check cell's own
 * twelve pixels, the box, and the open button that shows on hover.
 */
export const CHECK_WIDTH = 64

/**
 * A pinned cell stays put while the other columns scroll under it. Its
 * ground is the row's own, through the variable every row sets, so a pinned
 * cell is opaque in every state a row can be in (zebra, ticked, the cursor).
 * Never Kumo's `sticky` prop: it paints a 24 px fade over the next column at
 * rest.
 */
export const PIN_CELL = 'sticky z-[1] bg-(--kumo-table-row-bg)'
export const PIN_HEAD = 'sticky z-[2] bg-kumo-elevated'

/**
 * The pinned edge, drawn only once something has scrolled under it (the
 * scroller carries `data-scrolled` and `group/grid`). At rest there is
 * nothing under the pin to separate it from, and a shadow there would be a
 * line through the next column.
 *
 * A strip the full height of the cell, so one row's meets the next and the
 * column has one edge. It was a `box-shadow` of `6px 0 6px -6px`, and the
 * negative spread pulls a shadow in on every side, not only the far one:
 * each cell's shade stopped short of its own top and bottom and the edge
 * read as a stack of pills. A cell has one `box-shadow`, too, and the cursor
 * row's accent bar already wants the first cell's.
 */
export const PIN_EDGE =
  "after:pointer-events-none after:absolute after:inset-y-0 after:-right-[6px] after:w-[6px] after:bg-linear-to-r after:from-kumo-line after:to-transparent after:opacity-0 after:content-[''] group-data-[scrolled]/grid:after:opacity-100"

/** The cell the keyboard is on: the console's accent, inside the cell, so nothing moves. */
export const CURSOR = 'shadow-[inset_0_0_0_1.5px_var(--color-kumo-brand)]'

/** The row the keyboard is on (or the one in the inspector): tinted, with the accent bar on its first cell. */
export const CURSOR_ROW =
  'bg-kumo-tint [--kumo-table-row-bg:var(--color-kumo-tint)] [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-kumo-brand)]'
