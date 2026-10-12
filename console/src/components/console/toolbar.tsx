// A section's toolbar: two rows, and the split is a rule (SKILL "The two
// toolbar rows"). Row one is the scope — where you are, the connection, who
// the reads run as, and what acts on the whole section, with the primary
// action alone after the last divider. Row two is this one query — the
// filter, its count, and what came back. A persistent control keeps a fixed
// place; variable-length content runs after it.
//
// The classes are the Firestore page's, measured there, so no section has to
// re-derive them: row one is 44 px; row two is `box-content min-h-8` with
// its padding on the scroller itself, because a scroller clips at its padding
// edge and the field's focus ring is drawn outside its box.

import { cn } from '@cloudflare/kumo'
import type { ReactNode } from 'react'

/**
 * The stack of toolbar rows at the top of a section page. Its one column is
 * the page's width, never its rows' content: a row's path field shrinks
 * (and scrolls to its end) instead of pushing the controls after it out of
 * a narrow window.
 */
export function SectionToolbar({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="grid shrink-0 grid-cols-[minmax(0,1fr)]" data-testid={testId}>
      {children}
    </div>
  )
}

export function ToolbarRow({
  variant = 'scope',
  testId,
  below,
  overlay,
  children,
}: {
  /** `scope`: row one (44 px). `line`: row two, the query line. */
  variant?: 'scope' | 'line'
  testId?: string
  /** Row two only: lines under the row (the filter's message, chips); the overlay covers them too. */
  below?: ReactNode
  /**
   * Laid over the row while present — the `SelectionBar` while rows are
   * ticked. Laid over, never swapped in: the row keeps its height, so
   * nothing below moves under a shift-click, and the row goes `inert`.
   */
  overlay?: ReactNode
  children: ReactNode
}) {
  if (variant === 'scope') {
    const row = (
      <div
        className="flex h-11 shrink-0 items-center gap-1 border-b border-kumo-line bg-kumo-base pr-2 pl-3"
        data-testid={testId}
      >
        {children}
      </div>
    )
    return overlay ? <Overlaid overlay={overlay}>{row}</Overlaid> : row
  }
  const row = (
    <div className="grid shrink-0 border-b border-kumo-line bg-kumo-base" data-testid={testId}>
      <div className="box-content flex min-h-8 items-center gap-2 overflow-x-auto px-3 py-1.5">
        {children}
      </div>
      {below}
    </div>
  )
  return overlay ? <Overlaid overlay={overlay}>{row}</Overlaid> : row
}

function Overlaid({ overlay, children }: { overlay: ReactNode; children: ReactNode }) {
  return (
    <div className="relative shrink-0">
      <div inert>{children}</div>
      {overlay}
    </div>
  )
}

/**
 * The rule between two groups of toolbar controls. Draw one only where
 * there is a group on both sides of it: a rule before nothing, or after an
 * empty spacer, reads as a control that failed to load.
 */
export function ToolbarDivider() {
  return <span className="mx-1.5 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
}

/**
 * Row one's scope when it is a name rather than a path — "All functions",
 * "Users" with the tenant after it: 12 px medium in the default ink, its
 * detail in the quiet ink, where Firestore's path field starts. One style
 * for every section, so the row reads the same wherever it is.
 */
export function ToolbarScope({
  icon,
  detail,
  children,
  testId,
}: {
  icon?: ReactNode
  /** What qualifies the scope (a project, a tenant, a sentence), quieter and cut first. */
  detail?: ReactNode
  children: ReactNode
  testId?: string
}) {
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 px-1 text-[12px] whitespace-nowrap"
      data-testid={testId}
    >
      {icon ? <span className="flex shrink-0 text-kumo-subtle">{icon}</span> : null}
      <span className="min-w-0 shrink-0 truncate font-medium text-kumo-default">{children}</span>
      {detail ? <span className="min-w-0 truncate text-kumo-subtle">{detail}</span> : null}
    </span>
  )
}

/**
 * The path or query field: flat at rest (an outline is the one mark that
 * means "type here", so at rest it would lie about a breadcrumb), a ground
 * under the pointer, the ring only on focus — or at rest when what it holds
 * is invalid. The one control that acts on the whole field (copy, clear)
 * goes inside against the right edge, where a longer value cannot move it.
 */
export function ToolbarField({
  icon,
  invalid = false,
  trailing,
  children,
  testId,
  className,
}: {
  icon?: ReactNode
  invalid?: boolean
  trailing?: ReactNode
  children: ReactNode
  testId?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex h-8 min-w-0 flex-1 items-center rounded-lg pr-0.5 focus-within:bg-kumo-control focus-within:ring focus-within:ring-kumo-focus hover:not-focus-within:ink',
        invalid && 'ring ring-kumo-danger',
        className,
      )}
      data-testid={testId}
      data-invalid={invalid ? '' : undefined}
    >
      {icon ? (
        <span className="flex h-full shrink-0 items-center pl-2 text-kumo-subtle">{icon}</span>
      ) : null}
      <div className={cn('flex h-full min-w-0 flex-1 items-center', icon ? 'pl-1.5' : 'pl-2')}>
        {children}
      </div>
      {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
    </div>
  )
}
