// Links between sections (foundation spec §7.24): a payload names what it
// points at as an `EntityRef` (`auth.user`, `u_9f3k2`), and the target
// section's registry says where that opens (`routes[kind]`). No section
// knows another's URLs, and a link into a section that is absent or not
// built yet is plain text, so no stream waits on another's screens.

import { useQuery } from '@tanstack/react-query'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { statusQuery } from '@/api/queries'
import type { EntityRef } from './live/contract'
import { queryClient } from './query'
import { type SectionLink, sectionById } from './services'

/**
 * Where an `EntityRef` opens; `null` when its section is absent from this
 * engine, not built, or knows no such kind. `status` defaults to the one in
 * the query cache.
 */
export function linkTo(
  ref: Pick<EntityRef, 'kind' | 'key'>,
  status: ConsoleStatus | undefined = queryClient.getQueryData(statusQuery.queryKey),
): SectionLink | null {
  const dot = ref.kind.indexOf('.')
  if (dot <= 0) return null
  const section = sectionById(ref.kind.slice(0, dot))
  if (!section?.built) return null
  if (status?.sections.find((entry) => entry.id === section.id)?.state === 'absent') return null
  const route = section.routes?.[ref.kind]
  return route ? route(ref.key) : null
}

/** `linkTo`, kept current as the engine's sections come and go. */
export function useLinkTo(ref: Pick<EntityRef, 'kind' | 'key'> | undefined): SectionLink | null {
  const status = useQuery(statusQuery)
  return ref ? linkTo(ref, status.data) : null
}
