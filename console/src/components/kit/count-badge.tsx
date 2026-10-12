// A count beside a label: the nav's badges, a tab's failing tests. 10 px
// figures on a pill whose ground says how loud it is: danger is a red fill,
// attention a warning tint with a ring, neutral a quiet tint. A tooltip is
// not announced, so the count carries its sentence as its accessible name.

import { cn } from '@cloudflare/kumo'

export type CountTone = 'danger' | 'attention' | 'neutral'

const TONES: Record<CountTone, string> = {
  danger: 'bg-kumo-danger text-kumo-inverse',
  attention: 'bg-kumo-warning-tint text-kumo-default ring ring-kumo-warning',
  neutral: 'bg-kumo-tint text-kumo-subtle',
}

export function CountBadge({
  count,
  tone,
  label,
  className,
  testId,
}: {
  count: number
  tone: CountTone
  /** The sentence the number stands for ("1 rules file does not compile"). */
  label?: string
  className?: string
  testId?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex min-w-4 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] leading-4 font-medium tabular-nums',
        TONES[tone],
        className,
      )}
      aria-label={label}
      role={label ? 'img' : undefined}
      data-tone={tone}
      data-testid={testId}
    >
      {count > 999 ? '999+' : count}
    </span>
  )
}
