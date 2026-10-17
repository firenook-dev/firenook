// What the top bar's Connect opens, loaded after the first paint
// (`connect-button.tsx` draws the button before): the dialog, the first
// time it is asked for, and ⌘K's snippet rows (`palette.tsx`). The
// engine's configuration the snippets read (the default bucket, whether
// the project is a demo) is asked for with the dialog, and shared with the
// Overview's engine card.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Suspense, lazy, useCallback, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { connectSnippet } from '@/lib/connect'
import { type ConnectParam, connectTab } from '@/lib/connect-tabs'
import { engineQuery } from '@/overview/queries'
import { useConnectHost } from './host'
import { useConnectPalette } from './palette'

const ConnectDialog = lazy(() =>
  import('./connect-dialog').then((module) => ({ default: module.ConnectDialog })),
)

export function ConnectMount({
  status,
  param,
  onPick,
  onClose,
}: {
  status: ConsoleStatus
  /** The platform in the address; `undefined` while the dialog is closed. */
  param: ConnectParam | undefined
  onPick: (param: ConnectParam) => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const host = useConnectHost(status)
  const opened = param !== undefined
  const [asked, setAsked] = useState(opened)
  if (opened && !asked) setAsked(true)
  const project = status.projectId
  const engine = useQuery({ ...engineQuery(project), enabled: asked })

  // ⌘K copies without opening the dialog: the engine's configuration is
  // used when this tab has it (the Overview fetched it, or the dialog did),
  // and the snippet falls back to the default bucket's usual name otherwise.
  const snippet = useCallback(
    (next: ConnectParam) =>
      connectSnippet(connectTab(next).target, {
        services: status.services.map((service) => service.name),
        host: host.host,
        status,
        bucket: client.getQueryData(engineQuery(project).queryKey)?.config?.defaultBucket,
      }),
    [client, host.host, project, status],
  )
  useConnectPalette({ snippet })

  if (!asked) return null
  return (
    <Suspense fallback={null}>
      <ConnectDialog
        open={opened}
        onOpenChange={(next) => {
          if (!next) onClose()
        }}
        status={status}
        engine={engine.data}
        param={param}
        onParam={onPick}
      />
    </Suspense>
  )
}
