// The shell's own subscription: the engine's status patched into the query
// cache and its badges into a store, one subscription for the whole page,
// mounted by the shell. It also says what an engine restart does to the
// page: every query is invalidated, then the toast.

import { useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import { statusQuery } from '@/api/queries'
import { queryClient } from '@/lib/query'
import { toast } from '@/lib/toasts'
import { setRestartHooks } from './channel'
import type { Badge } from '@/api/generated/live/Badge'
import { useLiveTopic } from './use-live-topic'

/** The engine's badges by id, as the `shell` topic last sent them. */
export const useBadges = create<{ badges: ReadonlyMap<string, Badge> }>(() => ({
  badges: new Map(),
}))

export const RESTART_TOAST = {
  key: 'engine-restart',
  title: 'The engine restarted',
  description:
    'Everything on screen was reloaded. Selections were cleared; unsaved edits were kept.',
} as const

setRestartHooks({
  onRestart: () => void queryClient.invalidateQueries(),
  onRestarted: () => toast({ ...RESTART_TOAST, tone: 'success' }),
})

/** AppShell mounts it once. */
export function useShellLive(): void {
  const client = useQueryClient()
  useLiveTopic(
    'shell',
    {},
    {
      onStatus: (status) => client.setQueryData(statusQuery.queryKey, status),
      onBadges: (set) =>
        useBadges.setState({ badges: new Map(set.badges.map((badge) => [badge.id, badge])) }),
    },
  )
}
