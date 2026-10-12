// An action's failure in words: the engine's message, then its fix (the
// console's one error shape, `ApiError`), as the place that failed says it.

import { ApiError } from '@/api/client'

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.fix ? `${error.message} ${error.fix}` : error.message
  return error instanceof Error ? error.message : String(error)
}
