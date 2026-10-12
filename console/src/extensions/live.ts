// Extensions kept current by the live channel: `extensions.changes` names
// the instances a reload, a reconfigure, a vendor or an edited parameter
// file changed — keys only, coalesced by the engine in 100 ms — and each
// name refreshes that instance and the list. A reload of the instance's
// codebase seen by Functions' topic refreshes the same keys
// (`functions/live.ts`).

import { useQuery } from '@tanstack/react-query'
import type { ExtensionsChanged } from '@/api/generated/compute/ExtensionsChanged'
import { statusQuery } from '@/api/queries'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { declareTopic } from '@/lib/live/topics'
import { useInvalidateOn } from '@/lib/live/use-live-topic'
import { extensionKeys } from './api'

declare module '@/lib/live/topics' {
  interface TopicMap {
    'extensions.changes': {
      params: Record<string, never>
      events: { changed: ExtensionsChanged }
    }
  }
}

// Invalidation only: every tab of the browser can share one subscription.
declareTopic('extensions.changes', 'none')

/** The keys one `changed` event makes stale: the list, and each instance it names. */
export function changedKeys(project: string, changed: ExtensionsChanged) {
  return [
    extensionKeys.instances(project),
    ...changed.instanceIds.map((id) => extensionKeys.instance(project, id)),
  ]
}

const NO_PARAMS: Record<string, never> = {}

/** Keeps the section's instances current while mounted (`enabled: false` = not now). */
export function useExtensionsChanges(enabled = true): SubscriptionStatus {
  const project = useQuery(statusQuery).data?.projectId ?? ''
  return useInvalidateOn('extensions.changes', enabled ? NO_PARAMS : null, {
    keys: (_name, data) => changedKeys(project, data as ExtensionsChanged),
    resetKeys: [extensionKeys.all(project)],
  })
}
