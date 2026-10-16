// The title of a surface that hangs off a control — a popover, a dropdown,
// the inspector. Kumo's `heading` variant is 16 px, which is right for a
// dialog or a page section but three steps above the 12 px control a
// popover is attached to, so the whole surface reads as a larger world.
// One step above its own body is enough to be a title.

import { Text } from '@cloudflare/kumo'
import type { ReactNode } from 'react'

export function PanelTitle({
  as = 'h3',
  truncate = false,
  children,
}: {
  as?: 'h2' | 'h3' | 'h4'
  /**
   * One line, cut with an ellipsis where its box ends. A truncating wrapper
   * cannot do this for it: `text-overflow` does not reach a block child, so
   * the title was clipped mid-glyph with no ellipsis.
   */
  truncate?: boolean
  children: ReactNode
}) {
  return (
    <Text
      variant="heading"
      as={as}
      DANGEROUS_className={truncate ? 'min-w-0 truncate text-base' : 'text-base'}
    >
      {children}
    </Text>
  )
}
