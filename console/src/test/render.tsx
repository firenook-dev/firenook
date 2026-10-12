// Renders a component the way the console does: inside a router (memory
// history at `path`) and a query client that already holds the engine's
// status, so a test needs no engine and makes no request.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'

export async function renderInConsole(
  ui: () => ReactNode,
  options: { status?: ConsoleStatus; path?: string } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })
  if (options.status) client.setQueryData(['status'], options.status)
  // With no status, the engine has not answered yet: a request is never
  // answered rather than sent somewhere.
  else vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
  const root = createRootRoute({ component: () => <>{ui()}</> })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [options.path ?? '/'] }),
  })
  await router.load()
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...view, client, router }
}
