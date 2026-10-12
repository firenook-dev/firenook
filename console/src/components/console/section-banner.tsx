// One strip for "this is true right now": a rules file that stopped
// compiling, diagnostics turned off, background triggers paused. 13 px on a
// tinted ground with a hairline under it and a 14 px icon, one line, the
// action at its right end. The rules page's own strip, promoted to the kit.

import { Button, cn } from '@cloudflare/kumo'
import { InfoIcon, WarningIcon, XIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'

export type BannerTone = 'info' | 'warning' | 'danger'

const GROUND: Record<BannerTone, string> = {
  info: 'border-kumo-line bg-kumo-info-tint',
  warning: 'border-kumo-line bg-kumo-warning-tint',
  danger: 'border-kumo-danger bg-kumo-danger-tint',
}

const ICON: Record<BannerTone, string> = {
  info: 'text-kumo-info',
  warning: 'text-kumo-warning',
  danger: 'text-kumo-danger',
}

export function SectionBanner({
  tone,
  action,
  onDismiss,
  dismissLabel = 'Dismiss',
  testId,
  children,
}: {
  tone: BannerTone
  /** What the reader can do about it, at the strip's right end. */
  action?: ReactNode
  /** A strip the reader may put away gets a close button after the action. */
  onDismiss?: () => void
  dismissLabel?: string
  testId: string
  children: ReactNode
}) {
  const Icon = tone === 'info' ? InfoIcon : WarningIcon
  return (
    <div
      className={cn(
        'flex min-h-9 shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[13px]',
        GROUND[tone],
      )}
      role="status"
      data-testid={testId}
      data-tone={tone}
    >
      <Icon size={14} className={cn('shrink-0', ICON[tone])} />
      <span className="min-w-0 flex-1 text-kumo-default">{children}</span>
      {action && <span className="flex shrink-0 items-center gap-1.5">{action}</span>}
      {onDismiss && (
        <Button
          variant="ghost"
          size="xs"
          shape="square"
          icon={<XIcon />}
          onClick={onDismiss}
          aria-label={dismissLabel}
          data-testid={`${testId}-dismiss`}
        />
      )}
    </div>
  )
}
