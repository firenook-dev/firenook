// Which project a page shows. Normally the one the emulator was started
// with; but an app pointed at another project id (`my-prod` against a
// `demo-x` emulator) writes its data there, and a section that can scope by
// project shows it when the link says `?project=my-prod`. Only sections
// whose registry sets `projectScope` read the param — Storage buckets are
// not per project, so a `?project=` there means nothing and is ignored.

import { useQuery } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { statusQuery } from '@/api/queries'
import { SECTIONS } from './services'

/** Whether the section at `pathname` scopes by project. */
export function scopesByProject(pathname: string): boolean {
  const section = SECTIONS.find(
    (candidate) => pathname === candidate.to || pathname.startsWith(`${candidate.to}/`),
  )
  return section?.projectScope === true
}

/**
 * The project to show: `requested` where the section accepts one, else the
 * configured id. `foreign` is true only for a project other than the
 * emulator's own; asking for the configured one by name is not foreign.
 */
export function resolveConsoleProject(options: {
  configured: string | undefined
  requested: string | undefined
  scoped: boolean
}): { project: string; foreign: boolean } {
  const requested = options.scoped && options.requested ? options.requested : undefined
  if (requested !== undefined)
    return { project: requested, foreign: requested !== options.configured }
  return { project: options.configured ?? '', foreign: false }
}

/**
 * The project the page shows: `?project=` on a section with `projectScope`,
 * else the configured one (an empty string until the engine's status has
 * arrived).
 */
export function useConsoleProject(): { project: string; foreign: boolean } {
  const status = useQuery(statusQuery)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const requested = useRouterState({
    select: (state) => {
      const value = (state.location.search as Record<string, unknown>).project
      return typeof value === 'string' && value !== '' ? value : undefined
    },
  })
  return resolveConsoleProject({
    configured: status.data?.projectId,
    requested,
    scoped: scopesByProject(pathname),
  })
}
