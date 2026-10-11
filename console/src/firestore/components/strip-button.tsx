// One control of a row's strip.
//
// Kumo's own square button is the wrong tool here twice over. At `xs` it
// renders 12 px — the root font is 14 px, so every rem-based size comes
// out an eighth smaller than the design system means — and three of those
// two pixels apart read as one smudge rather than as three controls. And
// it has no pressed state to offer: `ghost` and `secondary` resolve to the
// same white square at this size, so the JSON toggle looked identical
// whether the row was in JSON or not, which is the state it exists to
// report.
//
// So the strip owns its buttons: one square, one gap, and `on` is
// something you can see. It is the same plain-button idiom the row
// already used for the integer/double word.

import { Tooltip } from '@cloudflare/kumo'
import type { ReactNode } from 'react'

export function StripButton({
  label,
  icon,
  on,
  tone,
  disabled,
  title,
  testId,
  onClick,
  children,
}: {
  label: string
  icon?: ReactNode
  /** Set for a control that reports a state, which then shows it. */
  on?: boolean | undefined
  tone?: 'danger' | undefined
  disabled?: boolean | undefined
  title?: string | undefined
  testId?: string | undefined
  onClick?: (() => void) | undefined
  /** A word rather than an icon, for the controls that are one. */
  children?: ReactNode
}) {
  const rest =
    tone === 'danger'
      ? 'text-kumo-subtle hover:ink hover:text-kumo-danger'
      : 'text-kumo-subtle hover:ink hover:text-kumo-default'
  const button = (
    <button
      type="button"
      aria-label={label}
      // Only where there is a state to report: a plain action that claimed
      // to be unpressed would be read out as a toggle that is off.
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={`flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1 font-mono text-[11px] outline-none focus-visible:ring focus-visible:ring-kumo-focus disabled:text-kumo-inactive disabled:hover:bg-none disabled:hover:text-kumo-inactive ${
        children === undefined ? 'w-6' : ''
      } ${on === true ? 'bg-kumo-control text-kumo-default ring ring-kumo-line' : rest}`}
    >
      {icon}
      {children}
    </button>
  )
  if (title === undefined) return button
  // The console's tooltip, not the browser's. A disabled button takes no
  // pointer events, so its tip hangs on a wrapper, as Kumo's Button does.
  return disabled ? (
    <Tooltip content={title} render={<span className="inline-flex shrink-0" />}>
      {button}
    </Tooltip>
  ) : (
    <Tooltip content={title} render={button} />
  )
}
