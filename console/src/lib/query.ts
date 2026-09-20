import { QueryClient } from '@tanstack/react-query'

// Server data lives here. Nothing polls: live updates arrive over the console
// channel and patch or invalidate these entries by scope.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
