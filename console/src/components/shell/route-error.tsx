// What a page shows when it fails to render. The common case is a page
// whose code no longer exists on the engine: the engine was updated under
// an open console and the page asked for one of its old chunks. Only a
// reload fixes that, so the page says so and offers it, as the shell's
// engine-updated banner does.

import { Button, Empty } from '@cloudflare/kumo'
import { ArrowClockwiseIcon, WarningIcon } from '@phosphor-icons/react'
import { Page } from './page'

/** Whether an error is a failed dynamic import (a chunk the engine no longer serves). */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch dynamically/i.test(
    message,
  )
}

export function RouteError({ error }: { error: unknown }) {
  const chunk = isChunkLoadError(error)
  const message = error instanceof Error ? error.message : String(error)
  return (
    <Page>
      <Empty
        icon={<WarningIcon size={48} className="text-kumo-inactive" />}
        title={chunk ? 'The console was updated' : 'This page failed to show'}
        description={
          chunk
            ? 'This page’s code no longer matches the engine’s console. Reload to get the new one.'
            : message
        }
        contents={
          <Button
            variant="secondary"
            icon={<ArrowClockwiseIcon />}
            onClick={() => window.location.reload()}
            data-testid="route-error-reload"
          >
            Reload
          </Button>
        }
      />
    </Page>
  )
}
