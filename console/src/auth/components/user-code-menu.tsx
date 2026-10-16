// "Code": this user as code that recreates them exactly — the Node and
// Python Admin SDKs, the emulator's REST API, and an accounts.json entry —
// typed from the stored record (`code.ts`), in the console's one Code
// popover (the last tab chosen is remembered for every user).

import { useQuery } from '@tanstack/react-query'
import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'
import { statusQuery } from '@/api/queries'
import { CodePopover } from '@/components/console/code-popover'
import { codeTab } from '@/components/console/request/as-code'
import { defaultConnectHost, hostLiteral } from '@/lib/connect'
import { userAsCode } from '../code'

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
  const auth = status.data?.services.find((service) => service.name === 'auth')
  const host = status.data ? defaultConnectHost(status.data).host : (auth?.host ?? '127.0.0.1')
  const context = {
    project,
    tenant,
    authAddress: `${hostLiteral(host)}:${auth?.port ?? 9099}`,
  }
  return (
    <CodePopover
      title="This user as code"
      kind="auth.user"
      tabs={[
        codeTab('node', userAsCode(detail, 'node', context)),
        codeTab('python', userAsCode(detail, 'python', context)),
        codeTab('rest', userAsCode(detail, 'rest', context)),
        {
          id: 'accounts',
          label: 'accounts.json entry',
          language: 'json',
          code: userAsCode(detail, 'accounts', context),
        },
      ]}
      label={words}
      width={600}
      testId="user-code"
    />
  )
}
