// Every copy in the console answers the same way: Kumo's rising tick
// (`CopyGlyph`), only once the clipboard has the text. `CopyButton` is the
// square icon control for a toolbar, a row's hover strip or a panel
// header; `CopyField` is a value set inline that copies itself, the way
// the inspector's path does.

import { Button, InlineCopyText, cn } from '@cloudflare/kumo'
import type { ReactNode } from 'react'
import { CopyGlyph, useCopied } from '@/components/kit'

export function CopyButton({
  value,
  label,
  size = 'sm',
  testId,
}: {
  value: string
  /** What is copied, said as an action: "Copy the URL". */
  label: string
  size?: 'xs' | 'sm'
  testId?: string
}) {
  const { copied, copy } = useCopied()
  return (
    <Button
      variant="ghost"
      size={size}
      shape="square"
      icon={<CopyGlyph copied={copied} />}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={(event) => {
        // A row or a menu under the button is not opened by copying from it.
        event.stopPropagation()
        void copy(value)
      }}
      data-copied={copied || undefined}
      data-testid={testId}
    />
  )
}

export function CopyField({
  value,
  children,
  mono = true,
  className,
  testId,
}: {
  value: string
  /** What is shown, when it is not the value itself. */
  children?: ReactNode
  /** A value is data, set in the data face (the default); `false` for English. */
  mono?: boolean
  className?: string
  testId?: string
}) {
  return (
    <InlineCopyText
      value={value}
      variant="body"
      size="xs"
      truncate
      className={cn(mono && 'font-mono', className)}
      data-testid={testId}
    >
      {children ?? value}
    </InlineCopyText>
  )
}
