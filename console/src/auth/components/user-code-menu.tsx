// "Code": this user as code that recreates them exactly — the Node and
// Python Admin SDKs, the emulator's REST API, and an accounts.json entry —
// typed from the stored record (`code.ts`).

import { Button, Popover, Tooltip } from '@cloudflare/kumo'
import { CodeIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'
import { statusQuery } from '@/api/queries'
import { CodeBlock } from '@/components/console/code-block'
import { defaultConnectHost, hostLiteral } from '@/lib/connect'
import { CODE_DIALECTS, type CodeDialect, userAsCode } from '../code'

export function UserCodeMenu({
  detail,
  project,
  tenant,
  words = true,
}: {
  detail: AuthUserDetail
  project: string
  tenant: string | undefined
  /** Room for the word on the trigger. */
  words?: boolean
}) {
  const status = useQuery(statusQuery)
  const [dialect, setDialect] = useState<CodeDialect>('node')
  const auth = status.data?.services.find((service) => service.name === 'auth')
  const host = status.data ? defaultConnectHost(status.data).host : (auth?.host ?? '127.0.0.1')
  const context = {
    project,
    tenant,
    authAddress: `${hostLiteral(host)}:${auth?.port ?? 9099}`,
  }
  return (
    <Popover>
      <Tooltip
        content="This user as code"
        render={
          <Popover.Trigger
            render={
              words ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<CodeIcon />}
                  aria-label="This user as code"
                  data-testid="user-code"
                >
                  Code
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  icon={<CodeIcon />}
                  aria-label="This user as code"
                  data-testid="user-code"
                />
              )
            }
          />
        }
      />
      <Popover.Content className="w-[600px] max-w-[calc(100vw-2rem)]">
        <CodeBlock
          label="This user as code"
          value={dialect}
          onValueChange={(id) => setDialect(id as CodeDialect)}
          dialects={CODE_DIALECTS.map((entry) => ({
            id: entry.id,
            label: entry.label,
            code: userAsCode(detail, entry.id, context),
          }))}
          testId="user-code-block"
        />
      </Popover.Content>
    </Popover>
  )
}
