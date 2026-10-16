// A secret typed into a form: a functions `.secret.local` value, an
// extension's secret param. It is a password field with its controls inside
// the box, at its end, read the way a masked value reads everywhere else in
// the console (`MaskedValue`): an eye shows what was typed, and only a shown
// value offers the kit's copy square, because a copy of something you have
// not seen is a paste you cannot check.
//
// Kumo's SensitiveInput is not used: its copy is a brand-coloured tab that
// rises over the field's top edge on hover, onto the label row above it.

import { InputGroup, cn } from '@cloudflare/kumo'
import { EyeIcon, EyeSlashIcon } from '@phosphor-icons/react'
import { type KeyboardEvent, useState } from 'react'
import { CopyButton } from '@/components/console/copy-button'

export function SecretInput({
  value,
  onChange,
  label,
  placeholder,
  invalid = false,
  autoFocus,
  onKeyDown,
  className,
  testId,
}: {
  value: string
  onChange: (value: string) => void
  /** The field's name, said to assistive technology: "API token". */
  label: string
  placeholder?: string | undefined
  /** The drafted value is refused: the box takes the danger ring. */
  invalid?: boolean | undefined
  autoFocus?: boolean | undefined
  onKeyDown?: ((event: KeyboardEvent<HTMLInputElement>) => void) | undefined
  className?: string | undefined
  testId?: string | undefined
}) {
  const [shown, setShown] = useState(false)
  return (
    <InputGroup size="sm" className={cn('min-w-0', className)}>
      <InputGroup.Input
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={invalid || undefined}
        // A browser offers saved passwords to a password field unless told
        // this is a new one.
        autoComplete="new-password"
        spellCheck={false}
        autoFocus={autoFocus}
        className="font-mono placeholder:font-sans"
        data-testid={testId}
      />
      <InputGroup.Addon align="end">
        <InputGroup.Button
          icon={shown ? EyeSlashIcon : EyeIcon}
          tooltip={shown ? 'Hide the value' : 'Show the value'}
          aria-pressed={shown}
          onClick={() => setShown((open) => !open)}
          data-testid={testId && `${testId}-reveal`}
        />
        {shown && value !== '' && (
          <CopyButton
            value={value}
            label="Copy the value"
            size="xs"
            {...(testId === undefined ? {} : { testId: `${testId}-copy` })}
          />
        )}
      </InputGroup.Addon>
    </InputGroup>
  )
}
