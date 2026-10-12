// A workbench page: full height, edge to edge, its own toolbar and borders.
// Every section page is this column, in the order foundation §4.5 sets:
// the panel (a portal into the shell's column), the toolbar rows, the
// page's own banners, then the body — the table or feed, and the inspector
// beside it.
//
// Routes put it inside `SectionFrame`, which draws the suite-wide banners
// above it and marks the section's badges seen while the section is ready.
// Used on its own (a page outside a frame), it does both itself, so the
// contract holds either way.

import { useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useMarkSeen } from '@/lib/badges'
import { type SectionId, sectionById } from '@/lib/services'
import { seenBadges, useInSectionFrame } from './section-gate'
import { ShellBanners } from './shell-banners'

export function SectionPage({
  section,
  page,
  title,
  testId,
  children,
}: {
  section: SectionId
  /** The registry page this is (`users`, `inbox`), for its badges and tests. */
  page?: string
  /** The page's name for assistive technology: the visible title is the toolbar's. */
  title: string
  testId: string
  children: ReactNode
}) {
  const framed = useInSectionFrame()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const entry = sectionById(section)
  useMarkSeen(framed || !entry ? [] : seenBadges(entry, pathname))
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid={testId}
      data-section={section}
      data-page={page}
    >
      <h1 className="sr-only">{title}</h1>
      {!framed && <ShellBanners section={section} />}
      {children}
    </div>
  )
}

/** The table and inspector row: the list fills it and the inspector sits beside it, or over it below `xl`. */
export function SectionBody({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="relative flex min-h-0 flex-1" data-testid={testId}>
      {children}
    </div>
  )
}
