// An object's download tokens, Admin only as in the official API: each one
// hidden until revealed and copied, revoked with a click; and a new one
// created. Both change the object's metadata, so the tooltips say the
// triggers run. A download that carries a valid token skips the rules, so
// such fetches never show as decisions. The download URL the first token
// makes is Location's (and the row menu's), not repeated per token.

import { Button, Tooltip } from '@cloudflare/kumo'
import { PlusIcon, XIcon } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { InspectorSection } from '@/components/console/inspector'
import { MaskedValue } from '@/components/console/masked-value'
import { OWNER_AUTHORIZATION, identityKey } from '@/lib/identity'
import { toast } from '@/lib/toasts'
import { changeToken } from '../../api'
import { storageKeys } from '../../queries'

export function Tokens({ object, project }: { object: StorageObjectDetail; project: string }) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<string | null>(null)
  if (!object.tokensVisible)
    return (
      <InspectorSection title="Tokens" testId="tokens">
        <p className="text-[13px] text-kumo-subtle" data-testid="tokens-admin-only">
          Only Admin can see and manage download tokens, as in the official API. Act as Admin to see
          them.
        </p>
      </InspectorSection>
    )
  const change = async (action: 'create' | 'revoke', token?: string) => {
    setPending(token ?? 'create')
    try {
      const next = await changeToken(
        { bucket: object.bucket, name: object.name, action, ...(token ? { token } : {}) },
        { authorization: OWNER_AUTHORIZATION },
      )
      queryClient.setQueryData(
        storageKeys.object(project, object.bucket, object.name, identityKey({ kind: 'owner' })),
        next,
      )
      toast({
        key: 'storage-token',
        title: action === 'create' ? 'Token created' : 'Token revoked',
        tone: 'success',
      })
    } catch (error) {
      toast({
        key: 'storage-token',
        title: action === 'create' ? 'Could not create a token' : 'Could not revoke the token',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setPending(null)
    }
  }
  return (
    <InspectorSection
      title="Tokens"
      count={object.downloadTokens.length}
      testId="tokens"
      action={
        <Tooltip
          content="Creates a token. Your onMetadataUpdated triggers run."
          render={
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<PlusIcon />}
              aria-label="Create a token"
              loading={pending === 'create'}
              onClick={() => void change('create')}
              data-testid="token-create"
            />
          }
        />
      }
    >
      {object.downloadTokens.length === 0 ? null : (
        <ul className="grid gap-0.5" data-testid="token-list">
          {object.downloadTokens.map((token) => (
            <li key={token} className="flex h-7 items-center gap-1" data-testid="token-row">
              <span className="min-w-0 flex-1 font-mono text-[12px]">
                <MaskedValue value={token} label="Show the token" copyable testId="token-value" />
              </span>
              <Tooltip
                content="Revokes this token; URLs that carry it stop working. Your onMetadataUpdated triggers run."
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    icon={<XIcon className="text-kumo-danger" />}
                    aria-label="Revoke the token"
                    loading={pending === token}
                    onClick={() => void change('revoke', token)}
                    data-testid="token-revoke"
                  />
                }
              />
            </li>
          ))}
        </ul>
      )}
      {object.downloadTokens.length === 0 && (
        <p className="text-[13px] text-kumo-subtle">
          No token: getDownloadURL() fails with storage/no-download-url until one is created.
        </p>
      )}
    </InspectorSection>
  )
}
