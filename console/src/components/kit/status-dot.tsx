// A status as a dot and a word, the vocabulary every list shares: allowed or
// denied, delivered or failed, running or stopped. 12 px, the word in the
// tone's text colour except for success and neutral, which stay quiet so
// the eye goes to what needs it. It keeps its width unless the caller lets
// it shrink (`className="min-w-0 shrink"`): the word then ends in an
// ellipsis rather than being cut mid-letter.

import { cn } from '@cloudflare/kumo'

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand'

// Kumo's `inactive` is a text colour only (`--text-color-kumo-inactive`), so
// a `bg-kumo-inactive` dot was drawn in nothing at all; `interact` is the same
// grey in both modes as a fill.
const DOT: Record<StatusTone, string> = {
  success: 'bg-kumo-success',
  warning: 'bg-kumo-warning',
  danger: 'bg-kumo-danger',
  neutral: 'bg-kumo-interact',
  brand: 'bg-kumo-brand',
}

const TEXT: Record<StatusTone, string> = {
  success: 'text-kumo-subtle',
  warning: 'text-kumo-warning',
  danger: 'text-kumo-danger',
  neutral: 'text-kumo-subtle',
  brand: 'text-kumo-brand',
}

export function StatusDot({
  tone,
  label,
  pulse = false,
  className,
  testId,
}: {
  tone: StatusTone
  label: string
  /** A state that is on its way (starting, running): the dot breathes. */
  pulse?: boolean
  className?: string
  testId?: string
}) {
  return (
    <span
      className={cn('flex shrink-0 items-center gap-1.5 text-[12px]', TEXT[tone], className)}
      data-tone={tone}
      data-testid={testId}
    >
      <span className="relative flex size-1.5" aria-hidden>
        {pulse && (
          <span
            className={cn(
              // Still for anyone who asked their system for less motion.
              'absolute inline-flex size-full animate-ping rounded-full motion-reduce:hidden',
              DOT[tone],
            )}
            data-part="pulse"
          />
        )}
        <span className={cn('relative inline-flex size-1.5 rounded-full', DOT[tone])} />
      </span>
      {/* The word ends in an ellipsis when a caller lets the dot shrink
          (`min-w-0 shrink`); the dot itself never does. */}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}
