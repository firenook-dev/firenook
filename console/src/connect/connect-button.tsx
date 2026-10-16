// "Connect your app", from the top bar on every page. The button and the
// address it writes are all the first route takes; what it opens — the
// dialog, the host picker, the snippet generator and ⌘K's snippet rows
// (`connect-mount.tsx`) — loads right after the first paint. The dialog's
// platform is in the address (`?connect=`, `navigation.ts`), so a link or
// ⌘K opens it on that tab over whatever page is on screen, and closing it
// drops the parameter.

import { Button } from '@cloudflare/kumo'
import { PlugsConnectedIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { Suspense, lazy } from 'react'
import { statusQuery } from '@/api/queries'
import { useConnectParam } from './navigation'

const ConnectMount = lazy(() =>
  import('./connect-mount').then((module) => ({ default: module.ConnectMount })),
)

export function ConnectButton() {
  const status = useQuery(statusQuery)
  const { param, open, pick, close } = useConnectParam()
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={<PlugsConnectedIcon size={14} />}
        onClick={() => open()}
        className="h-8 rounded-lg px-2.5 text-[13px]"
        aria-haspopup="dialog"
        data-testid="top-bar-connect"
      >
        Connect
      </Button>
      {status.data && (
        <Suspense fallback={null}>
          <ConnectMount status={status.data} param={param} onPick={pick} onClose={close} />
        </Suspense>
      )}
    </>
  )
}
