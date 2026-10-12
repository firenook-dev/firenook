// The one way a page offers to forget what it holds — Activity and Inbox
// history, invocations, a rules page's decisions: a ghost button whose
// glyph and word are in the danger tone, so it reads as destructive before
// it is pressed and never as the page's primary action. The confirmation,
// when the action needs one, is the page's.

import { Button } from '@cloudflare/kumo'
import { TrashIcon } from '@phosphor-icons/react'

export function ClearHistoryButton({
  label = 'Clear history…',
  onClick,
  disabled = false,
  title,
  testId,
}: {
  /** "Clear history…" (it asks first) or "Clear" (it does not). */
  label?: string
  onClick: () => void
  disabled?: boolean
  /** The accessible name, when the word alone does not say what is cleared. */
  title?: string | undefined
  testId?: string
}) {
  const tone = disabled ? undefined : 'text-kumo-danger'
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<TrashIcon className={tone} />}
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      title={title}
      data-testid={testId}
    >
      <span className={tone}>{label}</span>
    </Button>
  )
}
