// The navigation's badges: the count beside an item's label, and the dot an
// icon carries when the nav is collapsed to icons (the label and its count
// are out of sight then). Both read `useNavBadge`, which merges the
// engine's badges with this tab's and knows what was already seen.

import { Tooltip, cn } from '@cloudflare/kumo'
import type { Icon } from '@phosphor-icons/react'
import type { BadgeTone } from '@/api/generated/live/BadgeTone'
import { useNavBadge } from '@/lib/badges'
import { CountBadge } from './count-badge'

/** The count for these badge ids, with its sentence as tooltip and accessible name. */
export function NavBadge({ ids, testId }: { ids: readonly string[] | undefined; testId?: string }) {
  const badge = useNavBadge(ids)
  if (!badge) return null
  return (
    <Tooltip
      content={badge.label}
      side="right"
      render={
        // Positioned, so it sits above the menu button's own hover layer
        // (an absolute ::before over the row) and the pointer reaches it.
        <span className="relative ml-auto flex shrink-0 items-center group-data-[state=collapsed]/sidebar:hidden">
          <CountBadge
            count={badge.count}
            tone={badge.tone}
            label={badge.label}
            {...(testId ? { testId } : {})}
          />
        </span>
      }
    />
  )
}

const DOT: Record<BadgeTone | 'starting', string> = {
  danger: 'bg-kumo-danger',
  attention: 'bg-kumo-warning',
  neutral: 'bg-kumo-subtle',
  starting: 'bg-kumo-warning',
}

/**
 * A nav icon, drawn as Kumo's menu button draws its own but at 50 %, not 40,
 * with a 6 px dot at its top right: a badge's tone, seen only while the nav
 * is collapsed, or `starting`, a pulsing dot seen always. Collapsed, the
 * icon is all a page has to be told apart by, and at 40 % it was 2.55:1 on
 * the light rail, under the 3:1 an icon that carries meaning needs.
 */
export function NavIconWithDot({
  icon: IconComponent,
  tone,
  testId,
}: {
  icon: Icon
  tone?: BadgeTone | 'starting' | undefined
  testId?: string
}) {
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      <IconComponent className="size-4 opacity-50" />
      {tone && (
        <span
          className={cn(
            'absolute -top-0.5 -right-0.5 flex size-1.5',
            tone !== 'starting' && 'hidden group-data-[state=collapsed]/sidebar:flex',
          )}
          aria-hidden
          data-testid={testId}
          data-tone={tone}
        >
          {tone === 'starting' && (
            <span
              className={cn('absolute inline-flex size-full animate-ping rounded-full', DOT[tone])}
            />
          )}
          <span className={cn('relative inline-flex size-1.5 rounded-full', DOT[tone])} />
        </span>
      )}
    </span>
  )
}
