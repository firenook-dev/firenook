// What the Cloud Tasks page shows while the section starts (TK-70): the
// queue table's shape, and — once Functions discovery has run for 30
// seconds without the queues registering — where to look: queues come from
// `onTaskDispatched` exports, so a codebase that does not load leaves Cloud
// Tasks waiting, and the Functions section says why (while Functions is not
// built here, the engine's own output does).

import { SkeletonLine } from '@cloudflare/kumo'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { sectionById } from '@/lib/services'

/** How long discovery may run before the page says where to look, ms. */
export const SLOW_DISCOVERY_MS = 30_000

export function TasksStarting() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_DISCOVERY_MS)
    return () => clearTimeout(timer)
  }, [])
  const functions = sectionById('functions')
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 rounded-lg px-1 py-2" aria-hidden>
        <SkeletonLine minWidth={40} maxWidth={60} />
        {['a', 'b', 'c', 'd', 'e', 'f'].map((line) => (
          <SkeletonLine key={line} minWidth={70} maxWidth={100} />
        ))}
      </div>
      {slow && (
        <p className="m-0 text-[13px] text-kumo-default" data-testid="tasks-slow-discovery">
          Functions discovery has not finished after 30 seconds, and queues register from its{' '}
          <span className="font-mono text-[0.9em]">onTaskDispatched</span> exports —{' '}
          {functions?.built ? (
            <Link
              to={functions.to as never}
              className="text-kumo-link underline-offset-2 hover:underline"
            >
              see why in Functions
            </Link>
          ) : (
            'the engine’s output says why the codebase has not loaded'
          )}
          .
        </p>
      )}
    </div>
  )
}
