// The request as code, for a terminal or a script: curl, fetch or HTTPie
// against the service's own address, with the identity's token exactly as
// the console sends it — for an Auth user, the token the engine minted.
// The note under it says which host the code uses and why, because a
// console opened from another machine writes that machine's name.

import { Button, Popover, Text } from '@cloudflare/kumo'
import { CodeIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { CodeBlock } from '@/components/console/code-block'
import { SYNTHETIC_NOTE, userTokenQuery } from '@/lib/identity'
import { isLoopback } from '@/lib/connect'
import { describeAddress, type ServiceAddress } from './address'
import { CODE_DIALECTS, type CodeDialect, requestAsCode } from './as-code'
import type { ComposedRequest } from './types'

/** Which host the code uses, read back from its address when the caller did not say. */
function addressOf(codeUrl: string): ServiceAddress | undefined {
  try {
    const url = new URL(codeUrl)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const page = typeof location === 'undefined' ? '' : location.hostname
    const why = host === page && !isLoopback(host) ? 'browser' : 'engine'
    return { origin: url.origin, host, why }
  } catch {
    return undefined
  }
}

export function CodePopover({
  request,
  project,
  address,
  testId = 'request-code',
}: {
  request: ComposedRequest
  project: string
  /** The address `codeUrl` was built from (`serviceAddress`), for the note under the code. */
  address?: ServiceAddress
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  const [dialect, setDialect] = useState<CodeDialect>('curl')
  const identity = request.identity
  const token = useQuery({
    ...userTokenQuery(identity.kind === 'user' ? identity : { kind: 'user', uid: '' }, project),
    enabled: open && identity.kind === 'user',
  })
  const authorization = identity.kind === 'user' ? token.data?.authorization : undefined
  const where = address ?? addressOf(request.codeUrl)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button variant="ghost" size="sm" icon={<CodeIcon />} data-testid={testId}>
            Code
          </Button>
        }
      />
      <Popover.Content className="w-[560px] max-w-[calc(100vw-2rem)]">
        <div className="grid gap-2" data-testid={`${testId}-popover`}>
          <CodeBlock
            label="This request as code"
            value={dialect}
            onValueChange={(id) => setDialect(id as CodeDialect)}
            dialects={CODE_DIALECTS.map((item) => ({
              id: item.id,
              label: item.label,
              code: requestAsCode(request, item.id, project, authorization),
            }))}
            testId={`${testId}-block`}
          />
          {where && (
            <Text size="xs" variant="secondary">
              Sent to {describeAddress(where)}, not the console.
            </Text>
          )}
          {identity.kind === 'user' && token.data?.synthetic && (
            <Text size="xs" variant="secondary">
              {SYNTHETIC_NOTE}: the engine has no such account, so the token was made here.
            </Text>
          )}
          {identity.kind === 'user' && token.data && !token.data.synthetic && (
            <Text size="xs" variant="secondary">
              The token is the one the engine minted for this account; it stops working at{' '}
              {new Date(token.data.expiresAt).toLocaleTimeString()}.
            </Text>
          )}
        </div>
      </Popover.Content>
    </Popover>
  )
}
