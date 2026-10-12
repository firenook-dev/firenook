// What an `auth.users` window does to the Users page (§6.5): the rows it
// names are read again in one `POST /users:batchGet` (`useCursorRows.
// applyKeys`), which patches loaded rows where they stand, refetches only
// the page a new user sorts into and brings the count and facets with it.
// A deleted user flashes red for a moment before its row goes, so the eye
// sees what left; the open user's detail is read again when it is named;
// the claim keys only when some user's claims changed; the tenant picker's
// counts are marked stale (read again when it opens) when users came or
// went. A token refresh never arrives here: the engine drops it.
//
// `cleared`, `reset`, `end` and an engine restart start the table again
// from page one (the table keeps its anchor row by key where it can).

import { type QueryKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { AuthUsersChanged } from '@/api/generated/auth/AuthUsersChanged'
import { FLASH_MS } from '@/components/console/use-cursor-rows'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { readUsersWindow, useUsersTopic } from './live'
import { authKeys } from './queries'
import { type TenantScope, tenantKey } from './tenant-scope'

/** What the window handler needs from the page, injected so it can be tested without React. */
export interface UsersLiveDeps {
  /** `useCursorRows.applyKeys`. */
  applyKeys: (uids: readonly string[]) => void
  /** `useCursorRows.reset`. */
  reset: () => void
  /** The uid open in the inspector, read when a window arrives. */
  openUid: () => string | undefined
  /** Rows to draw as deleted (red) until they go; `[]` with `clear` takes them off. */
  markDeleted: (uids: readonly string[], on: boolean) => void
  /** Query keys to read again now. */
  refresh: (key: QueryKey) => void
  /** Query keys to mark stale, read again the next time they are used. */
  stale: (key: QueryKey) => void
  keys: {
    claims: QueryKey
    user: (uid: string) => QueryKey
    tenants: QueryKey
    summary: QueryKey
  }
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface UsersLive {
  changed: (window: AuthUsersChanged) => void
  /** `cleared`, `reset`, `end`: the table starts again; the open user is read again. */
  restart: () => void
  dispose: () => void
}

export function createUsersLive(deps: UsersLiveDeps): UsersLive {
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer =
    deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const timers = new Set<unknown>()
  const refreshOpen = (uids: readonly string[] | undefined) => {
    const open = deps.openUid()
    if (open !== undefined && (uids === undefined || uids.includes(open)))
      deps.refresh(deps.keys.user(open))
  }
  return {
    changed(changed) {
      const window = readUsersWindow(changed)
      const deleted = new Set(window.deleted)
      // A user created and deleted inside one window arrives as deleted.
      const now = window.uids.filter((uid) => !deleted.has(uid))
      if (now.length > 0) deps.applyKeys(now)
      if (window.deleted.length > 0) {
        const gone = [...window.deleted]
        deps.markDeleted(gone, true)
        const timer = setTimer(() => {
          timers.delete(timer)
          deps.applyKeys(gone)
          deps.markDeleted(gone, false)
        }, FLASH_MS)
        timers.add(timer)
      }
      if (window.claimsChanged) deps.refresh(deps.keys.claims)
      refreshOpen(window.uids)
      if (window.created.length > 0 || window.deleted.length > 0) {
        deps.stale(deps.keys.tenants)
        deps.stale(deps.keys.summary)
      }
    },
    restart() {
      deps.reset()
      refreshOpen(undefined)
      deps.refresh(deps.keys.claims)
      deps.stale(deps.keys.tenants)
    },
    dispose() {
      for (const timer of timers) clearTimer(timer)
      timers.clear()
    },
  }
}

/**
 * `auth.users` for the Users page while `enabled` (the scope is known to
 * exist): answers this page's subscription status and the rows to draw as
 * deleted for their last moment on screen.
 */
export function useUsersLive(options: {
  project: string
  scope: TenantScope
  enabled: boolean
  applyKeys: (uids: readonly string[]) => void
  reset: () => void
  openUid: string | undefined
}): { status: SubscriptionStatus; deleted: ReadonlySet<string> } {
  const queryClient = useQueryClient()
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set())
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })
  const { project, scope } = options
  const slot = tenantKey(scope)
  // The handler is made outside rendering (it reads the page's latest
  // options when a window arrives) and dropped with its pending timers.
  const handler = useRef<UsersLive | null>(null)
  useEffect(() => {
    const live = createUsersLive({
      applyKeys: (uids) => latest.current.applyKeys(uids),
      reset: () => latest.current.reset(),
      openUid: () => latest.current.openUid,
      markDeleted: (uids, on) =>
        setDeleted((current) => {
          const next = new Set(current)
          for (const uid of uids) {
            if (on) next.add(uid)
            else next.delete(uid)
          }
          return next
        }),
      refresh: (key) => void queryClient.invalidateQueries({ queryKey: key, exact: true }),
      stale: (key) => void queryClient.invalidateQueries({ queryKey: key, refetchType: 'none' }),
      keys: {
        get claims() {
          const now = latest.current
          return authKeys.claims(now.project, tenantKey(now.scope))
        },
        user: (uid) => {
          const now = latest.current
          return authKeys.user(now.project, tenantKey(now.scope), uid)
        },
        get tenants() {
          return authKeys.allTenantPicker(latest.current.project)
        },
        get summary() {
          return authKeys.summary(latest.current.project)
        },
      },
    })
    handler.current = live
    return () => {
      live.dispose()
      handler.current = null
    }
  }, [queryClient])
  // A new scope starts with nothing drawn as deleted.
  const [seen, setSeen] = useState(`${project}\u0000${slot}`)
  if (seen !== `${project}\u0000${slot}`) {
    setSeen(`${project}\u0000${slot}`)
    setDeleted(new Set())
  }
  const status = useUsersTopic(options.enabled ? project : '', scope, {
    onChanged: (changed) => handler.current?.changed(changed),
    onCleared: () => handler.current?.restart(),
    onReset: () => handler.current?.restart(),
    onEnd: () => handler.current?.restart(),
  })
  return { status, deleted }
}
