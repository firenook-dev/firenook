// One control of a row's strip: the field rows' type and JSON toggles, the
// JSON tree's copy path and copy value, a key-value row's copy.
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
import { CopyGlyph, useCopied } from '@/components/kit'

export function StripButton({
  label,
  icon,
  on,
  tone,
  disabled,
  title,
  testId,
  tabIndex,
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
  /** -1 where a list's own keys do the job and a stop per row would be a wall of tabs. */
  tabIndex?: number | undefined
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
      tabIndex={tabIndex}
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

/**
 * A strip control that copies: the console's copy glyph, which rises into a
 * tick once the clipboard has the text, so every copy answers alike.
 * `children` is a word beside the glyph (`path`, `value`) where the strip
 * holds more than one copy.
 */
export function CopyStripButton({
  value,
  label,
  title,
  testId,
  tabIndex,
  children,
}: {
  /** The text it copies, read when pressed. */
  value: string | (() => string)
  /** What it copies, for a screen reader: "Copy the path". */
  label: string
  /** The tooltip; the label when absent. */
  title?: string | undefined
  testId?: string | undefined
  tabIndex?: number | undefined
  children?: ReactNode
}) {
  const { copied, copy } = useCopied()
  return (
    <StripButton
      label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : (title ?? label)}
      icon={
        <span className="text-[13px]">
          <CopyGlyph copied={copied} />
        </span>
      }
      testId={testId}
      tabIndex={tabIndex}
      onClick={() => void copy(typeof value === 'function' ? value() : value)}
    >
      {children}
    </StripButton>
  )
}
