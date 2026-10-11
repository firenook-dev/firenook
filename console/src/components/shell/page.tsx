// The reading layout: a page with a gutter and a measure, for sections that
// are documents rather than workbenches (the overview, a placeholder, a
// settings form). Workbenches fill the content column edge to edge instead.

import type { ReactNode } from 'react'

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`px-6 py-5 ${className ?? ''}`}>{children}</div>
}
