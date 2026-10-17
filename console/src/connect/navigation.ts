// Opening, switching and closing "Connect your app" through the address:
// `?connect=<tab>` on the page on screen (`search.ts`), so it opens where
// it is asked for and a reload keeps it open on the same tab. Opening
// pushes an entry (Back closes the dialog); picking another platform or
// closing replaces it.

import { useNavigate, useSearch } from '@tanstack/react-router'
import { type ConnectParam, DEFAULT_CONNECT } from '@/lib/connect-tabs'
import { mergeSearch } from '@/lib/search-params'
import type { RootSearch } from './search'

type Navigate = ReturnType<typeof useNavigate>

/** Sets `?connect=` on the page on screen, everything else in its address kept. */
export function navigateConnect(
  navigate: Navigate,
  param: ConnectParam | undefined,
  options: { replace?: boolean } = {},
): void {
  void navigate({
    to: '.',
    search: ((previous: Record<string, unknown>) =>
      mergeSearch(previous, { connect: param })) as never,
    replace: options.replace ?? false,
  } as never)
}

/** The dialog's platform in the address, and the ways to change it. */
export function useConnectParam(): {
  /** The platform shown; `undefined` while the dialog is closed. */
  param: ConnectParam | undefined
  open: (param?: ConnectParam) => void
  pick: (param: ConnectParam) => void
  close: () => void
} {
  const param = useSearch({ strict: false, select: (search) => (search as RootSearch).connect })
  const navigate = useNavigate()
  return {
    param,
    // Asked again while open (⌘K, a link), it moves to that tab in place.
    open: (next = DEFAULT_CONNECT) =>
      navigateConnect(navigate, next, { replace: param !== undefined }),
    pick: (next) => navigateConnect(navigate, next, { replace: true }),
    close: () => navigateConnect(navigate, undefined, { replace: true }),
  }
}
