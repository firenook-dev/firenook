// The ID token the claims being edited would produce, decoded: minted by
// the engine from the draft (nothing stored, beforeSignIn never run here),
// so what a rule sees as `request.auth.token` is on screen before Save —
// including the claims Auth replaces with its own and the ones that replace
// a profile claim.

import { Select, Text } from '@cloudflare/kumo'
import type { AuthMintedToken } from '@/api/generated/auth/AuthMintedToken'
import { JsonTree } from '@/components/console/json-tree'
import { providerLabel } from '../providers'

/** Which provider the previewed token names: the section's one control. */
export function ProviderSelect({
  providers,
  provider,
  onProvider,
}: {
  /** The providers the account could have signed in with. */
  providers: readonly string[]
  /** The provider the token names. */
  provider: string | undefined
  onProvider: (provider: string | undefined) => void
}) {
  if (providers.length < 2) return null
  return (
    <div className="w-44 min-w-0">
      <Select
        size="xs"
        value={provider ?? ''}
        onValueChange={(value) => onProvider(String(value) || undefined)}
        renderValue={() => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-kumo-subtle">Provider</span>
            <span className="truncate font-mono">{provider}</span>
          </span>
        )}
        aria-label="Provider the token names"
        className="h-6.5 w-full min-w-0 rounded-md"
      >
        {providers.map((id) => (
          <Select.Option key={id} value={id}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-[12px]">{id}</span>
              <span className="ml-auto shrink-0 text-[11px] text-kumo-subtle">
                {providerLabel(id)}
              </span>
            </span>
          </Select.Option>
        ))}
      </Select>
    </div>
  )
}

export function TokenPreview({
  minted,
  error,
}: {
  minted: AuthMintedToken | undefined
  /** Why the engine would not mint one for this draft. */
  error: string | undefined
}) {
  return (
    <div className="grid gap-2" data-testid="token-preview">
      {error ? (
        <p className="text-[12px] text-kumo-danger" data-testid="token-preview-error">
          {error}
        </p>
      ) : minted ? (
        <JsonTree
          value={minted.payload}
          defaultDepth={2}
          height={320}
          ariaLabel="The ID token's payload"
          testId="token-preview-tree"
        />
      ) : (
        <Text variant="secondary" size="sm">
          Minting…
        </Text>
      )}
      <p className="text-[12px] text-kumo-subtle">
        Signed-in clients see new claims after their ID token refreshes (within an hour) or when the
        app calls <span className="font-mono text-[0.9em]">getIdToken(true)</span>.
      </p>
    </div>
  )
}
