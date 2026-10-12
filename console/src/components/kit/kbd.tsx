// A key, as the console writes one beside a label: in tooltips, hints and
// the shortcuts dialog. 10 px, the size of chrome figures, on the base
// ground with a hairline, so it reads as a key cap without competing with
// the words beside it.

import { cn } from '@cloudflare/kumo'
import type { ReactNode } from 'react'

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px] text-kumo-subtle',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
