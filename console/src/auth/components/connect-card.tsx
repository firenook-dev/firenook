// How to point an app at this Auth emulator: the snippets of the console's
// one generator (`lib/connect.ts`) for service `auth`, with this engine's
// connect host and port and its project id — never a port typed here. The
// Android tab uses `10.0.2.2` when the engine listens on this machine's
// loopback, which is how the Android emulator reaches it.

import { useQuery } from '@tanstack/react-query'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { statusQuery } from '@/api/queries'
import { type CodeDialect, CodeBlock } from '@/components/console/code-block'
import { ANDROID_HOST, connectSnippet, defaultConnectHost, isLoopback } from '@/lib/connect'
import type { ConnectTarget } from '@/lib/connect-tabs'

/** The tabs, in order: the client SDKs, then the Admin SDK and its environment. */
export const CONNECT_TABS: readonly { id: ConnectTarget; label: string }[] = [
  { id: 'web', label: 'Web' },
  { id: 'flutter', label: 'Flutter' },
  { id: 'apple', label: 'iOS' },
  { id: 'android', label: 'Android' },
  { id: 'admin-node', label: 'Admin (Node.js)' },
  { id: 'env', label: 'Environment' },
]

/** The Connect card's snippets for this engine: `lib/connect.ts`'s, nothing written here. */
export function connectDialects(status: ConsoleStatus, pageHost?: string): CodeDialect[] {
  const host = defaultConnectHost(status, pageHost).host
  return CONNECT_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    code: connectSnippet(tab.id, {
      services: ['auth'],
      status,
      ...(tab.id === 'android' && isLoopback(host) ? { host: ANDROID_HOST } : {}),
    }),
  }))
}

export function ConnectCard() {
  const status = useQuery(statusQuery)
  if (!status.data) return null
  return (
    <div data-testid="connect-card">
      <CodeBlock
        label="Point your app at this Auth emulator"
        dialects={connectDialects(status.data)}
        testId="connect-snippet"
      />
    </div>
  )
}
