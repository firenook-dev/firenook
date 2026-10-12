// "View the token…": the ID token Sign in as minted, decoded, with how long
// it lasts, the raw token to copy, Inspect (how each consumer would judge
// it), and — one sentence each, the engine's own — what still differs from
// a token a real sign-in would have produced.

import { Button, ClipboardText, Dialog } from '@cloudflare/kumo'
import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import type { AuthMintedToken } from '@/api/generated/auth/AuthMintedToken'
import { JsonTree } from '@/components/console/json-tree'
import { PanelTitle } from '@/components/kit'
import { formatDuration, relativeTime } from '@/lib/format'
import { handOffToken } from '../inspect-handoff'
import { projectParam } from '../tenant-scope'

export function TokenDialog({
  open,
  onOpenChange,
  minted,
  who,
  project,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  minted: AuthMintedToken | undefined
  /** Whom it was minted for: the identifier. */
  who: string
  project: string
}) {
  const navigate = useNavigate()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6 sm:w-[720px]">
        <div className="flex max-h-[calc(100vh-6rem)] flex-col" data-testid="token-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">ID token for {who}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          {minted && (
            <>
              <Dialog.Description className="text-kumo-subtle">
                Minted by the engine for {minted.provider} sign-in
                {minted.secondFactor
                  ? ` with the factor ${minted.secondFactor.phoneNumber ?? ''}`
                  : ''}
                ; expires {relativeTime(minted.expiresAt)}. Nothing was stored.
              </Dialog.Description>
              <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
                <div className="flex min-w-0 items-center gap-2">
                  <ClipboardText text={minted.idToken} size="sm" className="min-w-0 flex-1" />
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<MagnifyingGlassIcon />}
                    onClick={() => {
                      handOffToken(minted.idToken)
                      onOpenChange(false)
                      void navigate({
                        to: '/auth/activity' as never,
                        search: { panel: 'inspect', project: projectParam(project) } as never,
                      })
                    }}
                    data-testid="token-inspect"
                  >
                    Inspect
                  </Button>
                </div>
                {minted.beforeSignIn && (
                  <p className="text-[13px] text-kumo-default" data-testid="token-before-sign-in">
                    beforeSignIn ({minted.beforeSignIn.function ?? 'your function'}) ran in{' '}
                    {formatDuration(minted.beforeSignIn.durationMicros / 1_000)}
                    {minted.beforeSignIn.customClaims.length > 0
                      ? `; custom claims ${minted.beforeSignIn.customClaims.join(', ')}`
                      : ''}
                    {minted.beforeSignIn.sessionClaims.length > 0
                      ? `; session claims ${minted.beforeSignIn.sessionClaims.join(', ')}`
                      : ''}
                    .
                  </p>
                )}
                {minted.differences.length > 0 && (
                  <div className="grid gap-1.5" data-testid="token-differences">
                    <PanelTitle as="h4">What differs from a real sign-in</PanelTitle>
                    <ul className="grid list-disc gap-1 pl-5 text-[13px] text-kumo-subtle">
                      {minted.differences.map((difference) => (
                        <li key={difference}>{difference}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="grid gap-1.5">
                  <PanelTitle as="h4">Payload</PanelTitle>
                  <JsonTree
                    value={minted.payload}
                    defaultDepth={2}
                    height={360}
                    ariaLabel="The token's payload"
                    testId="token-payload"
                  />
                </div>
              </div>
            </>
          )}
          <div className="mt-5 flex justify-end">
            <Dialog.Close render={<Button variant="secondary">Close</Button>} />
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
