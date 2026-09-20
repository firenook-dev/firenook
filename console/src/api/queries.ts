import { queryOptions } from '@tanstack/react-query'
import { api } from './client'

export const statusQuery = queryOptions({
  queryKey: ['status'],
  queryFn: api.status,
})
