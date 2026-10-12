// A part of the Overview whose request failed, said in its own place and
// in the page's scale: the engine's message, its fix, and Retry. The rest
// of the page keeps working.

import { Button } from '@cloudflare/kumo'
import { WarningIcon } from '@phosphor-icons/react'
import { ApiError } from '@/api/client'

export function SectionError({
  error,
  onRetry,
  testId,
}: {
  error: unknown
  onRetry: () => void
  testId: string
}) {
  const message = error instanceof Error ? error.message : String(error)
  const fix = error instanceof ApiError ? error.fix : undefined
  return (
    <div
      className="flex min-w-0 items-start gap-2.5 px-4 py-3 text-[13px]"
      role="alert"
      data-testid={testId}
    >
      <WarningIcon size={16} className="mt-px shrink-0 text-kumo-warning" aria-hidden />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-kumo-default">{message || 'The engine did not answer.'}</span>
        {fix && <span className="text-kumo-subtle">{fix}</span>}
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry} data-testid={`${testId}-retry`}>
        Retry
      </Button>
    </div>
  )
}
