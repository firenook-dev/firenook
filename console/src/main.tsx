import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouteError } from '@/components/shell/route-error'
import { startTheme } from '@/lib/color-mode'
import { queryClient } from '@/lib/query'
import { routeTree } from './routeTree.gen'
import './styles.css'

startTheme()

const router = createRouter({
  routeTree,
  basepath: '/console',
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  // A page that fails renders inside the shell, with a reload when its
  // code is gone (the engine was updated under it).
  defaultErrorComponent: RouteError,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('The console root element is missing')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
