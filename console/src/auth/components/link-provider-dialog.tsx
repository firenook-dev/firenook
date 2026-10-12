// Link a provider to an account without the provider: "this user has
// Google" for a test, through `accounts:update { linkProviderUserInfo }` as
// the Admin SDK links one. The raw id is made up unless one is typed — the
// emulator never asks the provider.

import { Button, Dialog } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'
import { LINKABLE_PROVIDERS, providerGlyph, providerLabel } from '../providers'
import { type UserTarget, linkProvider, refusal } from '../user-actions'
import { DialogField, DialogInput } from './dialog-field'

/** A provider-side id as federated providers write theirs: a long run of digits. */
export function randomRawId(): string {
  let id = String(1 + Math.floor(Math.random() * 9))
  while (id.length < 21) id += String(Math.floor(Math.random() * 10))
  return id
}

export function LinkProviderDialog({
  open,
  onOpenChange,
  target,
  detail,
  onLinked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: UserTarget
  detail: AuthUserDetail
  onLinked: () => void
}) {
  // Each opening starts a fresh form; the dialog itself stays mounted.
  const [session, setSession] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSession((count) => count + 1)
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6">
        <LinkProviderForm
          key={session}
          target={target}
          detail={detail}
          onLinked={() => {
            onLinked()
            onOpenChange(false)
          }}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function LinkProviderForm({
  target,
  detail,
  onLinked,
}: {
  target: UserTarget
  detail: AuthUserDetail
  onLinked: () => void
}) {
  const linked = new Set(detail.providerInfo.map((provider) => provider.providerId))
  const offered = LINKABLE_PROVIDERS.filter((id) => !linked.has(id))
  const [providerId, setProviderId] = useState('')
  const [rawId, setRawId] = useState(randomRawId)
  const [email, setEmail] = useState(detail.row.email ?? '')
  const [displayName, setDisplayName] = useState(detail.row.displayName ?? '')
  const [photoUrl, setPhotoUrl] = useState('')
  const link = useMutation({
    mutationFn: () =>
      linkProvider(target, {
        providerId: providerId.trim(),
        rawId: rawId.trim(),
        email: email.trim() || undefined,
        displayName: displayName.trim() || undefined,
        photoUrl: photoUrl.trim() || undefined,
      }),
    onSuccess: onLinked,
  })
  const taken = linked.has(providerId.trim())
  const ready = providerId.trim() !== '' && rawId.trim() !== '' && !taken
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) link.mutate()
      }}
      data-testid="link-provider-dialog"
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">Link a provider</Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <Dialog.Description className="text-kumo-subtle">
        The account then signs in with this provider as if it had been linked from your app. The
        emulator never contacts the provider.
      </Dialog.Description>
      <div className="mt-4 grid gap-3">
        <DialogField
          label="Provider id"
          error={taken ? 'This account already has this provider.' : undefined}
        >
          <DialogInput
            value={providerId}
            onChange={setProviderId}
            placeholder="google.com, saml.my-idp, oidc.my-provider"
            autoFocus
            invalid={taken}
            testId="link-provider-id"
          />
        </DialogField>
        {offered.length > 0 && (
          <div className="-mt-1 flex flex-wrap gap-1" data-testid="link-provider-known">
            {offered.map((id) => {
              const Glyph = providerGlyph(id)
              return (
                <Button
                  key={id}
                  type="button"
                  variant={providerId === id ? 'secondary' : 'ghost'}
                  size="xs"
                  icon={<Glyph />}
                  onClick={() => setProviderId(id)}
                  aria-pressed={providerId === id}
                  title={providerLabel(id)}
                >
                  <span className="font-mono text-[11px]">{id}</span>
                </Button>
              )
            })}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <DialogField label="Raw id" hint="(the provider’s id)">
            <DialogInput value={rawId} onChange={setRawId} testId="link-raw-id" />
          </DialogField>
          <DialogField label="Email">
            <DialogInput value={email} onChange={setEmail} type="email" testId="link-email" />
          </DialogField>
          <DialogField label="Display name">
            <DialogInput value={displayName} onChange={setDisplayName} testId="link-name" />
          </DialogField>
          <DialogField label="Photo URL">
            <DialogInput value={photoUrl} onChange={setPhotoUrl} type="url" testId="link-photo" />
          </DialogField>
        </div>
      </div>
      {link.isError && (
        <p className="mt-3 text-[13px] text-kumo-danger" data-testid="link-provider-error">
          {refusal(link.error)}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Dialog.Close render={<Button variant="secondary">Cancel</Button>} />
        <Button
          type="submit"
          variant="primary"
          disabled={!ready}
          loading={link.isPending}
          data-testid="link-provider-submit"
        >
          Link provider
        </Button>
      </div>
    </form>
  )
}
