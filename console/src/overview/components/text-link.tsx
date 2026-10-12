// A link in the Overview's prose and cards: the console's link colour, an
// underline under the pointer, routed in place (never a page load).

import { cn } from '@cloudflare/kumo'
import { Link } from '@tanstack/react-router'
import type { MouseEvent, ReactNode } from 'react'
import type { SectionLink } from '@/lib/services'

export const LINK_CLASS =
  'rounded-xs text-kumo-link underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none'

export function TextLink({
  link,
  children,
  className,
  onClick,
  testId,
}: {
  link: SectionLink
  children: ReactNode
  className?: string | undefined
  onClick?: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined
  testId?: string | undefined
}) {
  return (
    <Link
      to={link.to as never}
      search={link.search as never}
      className={cn(LINK_CLASS, className)}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </Link>
  )
}
