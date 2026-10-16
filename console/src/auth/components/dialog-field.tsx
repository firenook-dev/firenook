// A labelled value in an Authentication dialog, set the way the Firestore
// create dialog sets its ids: a 13 px label over a 28 px box, the value in
// the data face (an email, a uid, a phone, a URL is data), and what is
// wrong with it, or a hint, under it.

import { Text, cn } from '@cloudflare/kumo'
import type { ReactNode } from 'react'

/** The box a dialog's value is typed into. */
export const DIALOG_INPUT =
  'h-8 w-full min-w-0 rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring outline-none placeholder:font-sans placeholder:text-kumo-placeholder focus:ring-kumo-focus'

export function DialogField({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode
  /** Quiet words after the label: "(blank for a generated id)". */
  hint?: ReactNode
  error?: string | undefined
  children: ReactNode
  className?: string
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the control is the child
    <label className={cn('grid min-w-0 content-start gap-1', className)}>
      <Text variant="secondary" size="sm" as="span">
        {label}
        {hint ? <span className="text-kumo-inactive"> {hint}</span> : null}
      </Text>
      {children}
      {error && <span className="text-[12px] text-kumo-danger">{error}</span>}
    </label>
  )
}

/** A text input in a dialog, ringed red while its value is wrong. */
export function DialogInput({
  value,
  onChange,
  invalid = false,
  placeholder,
  autoFocus,
  type = 'text',
  testId,
}: {
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  placeholder?: string
  autoFocus?: boolean
  type?: 'text' | 'email' | 'url' | 'tel'
  testId?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      autoComplete="off"
      placeholder={placeholder}
      autoFocus={autoFocus}
      className={cn(DIALOG_INPUT, invalid ? 'ring-kumo-danger' : 'ring-kumo-line')}
      data-testid={testId}
    />
  )
}
