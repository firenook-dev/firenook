// When a coding agent last called this engine through `firenook mcp`: the
// MCP server posts a beacon after each tool call (`POST /agents/calls`) and
// the Coding agent tab reads `GET /agents`. Read when the tab opens and
// again when the window is focused (someone switched to their agent and
// back); never polled.

import { queryOptions } from '@tanstack/react-query'
import { apiGet } from '@/api/client'
import type { AgentActivity } from '@/api/generated/AgentActivity'

export const agentsQuery = queryOptions({
  queryKey: ['agents'],
  queryFn: ({ signal }) => apiGet<AgentActivity>('/agents', undefined, signal),
  staleTime: 0,
  refetchOnWindowFocus: true,
})
