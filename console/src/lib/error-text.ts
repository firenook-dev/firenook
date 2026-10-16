// How a failure reads in a dialog, a banner or a toast: an engine refusal
// says what went wrong and then how to fix it (`ApiError.fix`), anything
// else its own message.

import { ApiError } from '@/api/client'

/** An engine refusal as its message and then its fix; anything else as its message. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.fix ? `${error.message} ${error.fix}` : error.message
  return error instanceof Error ? error.message : String(error)
}
