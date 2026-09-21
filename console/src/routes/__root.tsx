import { Empty, Link } from '@cloudflare/kumo'
import type { QueryClient } from '@tanstack/react-query'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { CompassIcon } from '@phosphor-icons/react'
import { lazy } from 'react'
import { AppShell } from '@/components/shell/app-shell'
import { Page } from '@/components/shell/page'

export interface RouterContext {
  queryClient: QueryClient
}

const Devtools = import.meta.env.DEV
  ? lazy(() => import('@/components/shell/devtools').then((m) => ({ default: m.Devtools })))
  : () => null

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
})

function RootLayout() {
  return (
    <AppShell>
      <Outlet />
      <Devtools />
    </AppShell>
  )
}

function NotFound() {
  return (
    <Page>
      <Empty
        icon={<CompassIcon size={48} className="text-kumo-inactive" />}
        title="Nothing at this address"
        description="The console has no page here."
        contents={<Link href="/console">Back to the overview</Link>}
      />
    </Page>
  )
}
