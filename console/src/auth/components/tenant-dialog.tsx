// A tenant, created with the id you choose (`acme`) or a generated one, or
// edited: its display name, the sign-in methods it allows, whether
// authentication is turned off, and its multi-factor state. Creating goes
// through the Console API (the official `tenants.create` takes no id);
// editing through `tenants.patch` with the Admin SDK's credential, only the
// fields that changed in its `updateMask`.

import { Button, Checkbox, Dialog, Input, Select, Switch, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { AuthTenant } from '@/api/generated/auth/AuthTenant'
import { authKeys } from '../queries'
import {
  MFA_STATES,
  MFA_STATE_LABELS,
  type MfaState,
  NEW_TENANT,
  type TenantForm,
  createFromForm,
  formOfTenant,
  patchOf,
  tenantIdProblem,
  updateTenant,
} from '../tenants'

/** What the dialog is for: a new tenant, or one to edit. */
export type TenantDialogMode = { kind: 'create' } | { kind: 'edit'; tenant: AuthTenant }

export function TenantDialog({
  project,
  mode,
  onClose,
  onCreated,
}: {
  project: string
  /** Absent: closed. */
  mode: TenantDialogMode | undefined
  onClose: () => void
  onCreated?: ((tenant: AuthTenant) => void) | undefined
}) {
  // The last mode stays rendered while the dialog animates closed.
  const [shown, setShown] = useState(mode)
  const [session, setSession] = useState(0)
  if (mode !== undefined && mode !== shown) {
    setShown(mode)
    setSession((count) => count + 1)
  }
  return (
    <Dialog.Root open={mode !== undefined} onOpenChange={(next) => !next && onClose()}>
      <Dialog size="lg" className="p-6">
        {shown && (
          <TenantFormView
            key={session}
            project={project}
            mode={shown}
            onClose={onClose}
            onCreated={onCreated}
          />
        )}
      </Dialog>
    </Dialog.Root>
  )
}

function TenantFormView({
  project,
  mode,
  onClose,
  onCreated,
}: {
  project: string
  mode: TenantDialogMode
  onClose: () => void
  onCreated: ((tenant: AuthTenant) => void) | undefined
}) {
  const before = mode.kind === 'edit' ? formOfTenant(mode.tenant) : NEW_TENANT
  const [form, setForm] = useState<TenantForm>(before)
  const set = (patch: Partial<TenantForm>) => setForm((current) => ({ ...current, ...patch }))
  const queryClient = useQueryClient()
  const idProblem = mode.kind === 'create' ? tenantIdProblem(form.tenantId) : undefined
  const patch = mode.kind === 'edit' ? patchOf(before, form) : undefined
  const save = useMutation({
    mutationFn: async () => {
      if (mode.kind === 'create') return createFromForm(project, form)
      if (patch) await updateTenant(project, mode.tenant.tenantId, patch)
      return undefined
    },
    onSuccess: (created) => {
      // `auth.config` tells every open page too; this page need not wait for it.
      void queryClient.invalidateQueries({ queryKey: authKeys.allTenants(project) })
      void queryClient.invalidateQueries({ queryKey: authKeys.allTenantPicker(project) })
      void queryClient.invalidateQueries({ queryKey: authKeys.allConfig(project) })
      if (created) onCreated?.(created)
      onClose()
    },
  })
  const blocked = idProblem !== undefined || (mode.kind === 'edit' && patch === undefined)
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) save.mutate()
      }}
      data-testid="tenant-dialog"
    >
      <div className="flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">
          {mode.kind === 'create' ? (
            'New tenant'
          ) : (
            <>
              Tenant <span className="font-mono text-[0.9em]">{mode.tenant.tenantId}</span>
            </>
          )}
        </Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <Dialog.Description className="text-kumo-subtle">
        {mode.kind === 'create'
          ? 'Users of a tenant are kept apart from the project’s own; an app reaches them by setting auth.tenantId.'
          : 'Changes go through tenants.patch, as the Admin SDK’s updateTenant sends them.'}
      </Dialog.Description>
      {mode.kind === 'create' && (
        <Row
          label="Tenant id"
          hint={idProblem ?? 'Leave it empty for a generated 28-character id.'}
          danger={idProblem !== undefined}
        >
          <Input
            size="sm"
            value={form.tenantId}
            onChange={(event) => set({ tenantId: event.target.value })}
            placeholder="acme"
            aria-label="Tenant id"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            className="w-full font-mono"
            data-testid="tenant-id"
          />
        </Row>
      )}
      <Row label="Display name">
        <Input
          size="sm"
          value={form.displayName}
          onChange={(event) => set({ displayName: event.target.value })}
          placeholder="Acme Corp"
          aria-label="Display name"
          autoComplete="off"
          className="w-full font-mono"
          data-testid="tenant-display-name"
        />
      </Row>
      <div className="grid gap-2.5" role="group" aria-label="Sign-in methods">
        <Text variant="secondary" size="sm" as="span">
          Sign-in
        </Text>
        <Toggle
          label="Password sign-up"
          checked={form.allowPasswordSignup}
          onChange={(allowPasswordSignup) => set({ allowPasswordSignup })}
          testId="tenant-password"
        />
        <Toggle
          label="Email link sign-in"
          checked={form.enableEmailLinkSignin}
          onChange={(enableEmailLinkSignin) => set({ enableEmailLinkSignin })}
          testId="tenant-email-link"
        />
        <Toggle
          label="Anonymous sign-in"
          checked={form.enableAnonymousUser}
          onChange={(enableAnonymousUser) => set({ enableAnonymousUser })}
          testId="tenant-anonymous"
        />
        <Toggle
          label="Turn off sign-in for this tenant (disableAuth)"
          checked={form.disableAuth}
          onChange={(disableAuth) => set({ disableAuth })}
          testId="tenant-disable-auth"
        />
      </div>
      <Row label="Multi-factor authentication">
        <div className="flex items-center gap-3">
          <Select
            size="sm"
            value={form.mfaState}
            onValueChange={(next) => set({ mfaState: next as MfaState })}
            items={Object.fromEntries(MFA_STATES.map((state) => [state, MFA_STATE_LABELS[state]]))}
            aria-label="Multi-factor authentication"
            className="w-36"
            data-testid="tenant-mfa"
          />
          <Checkbox
            checked={form.mfaSms}
            onCheckedChange={(checked) => set({ mfaSms: checked === true })}
            label="SMS"
            disabled={form.mfaState === 'DISABLED'}
          />
        </div>
      </Row>
      {save.error && (
        <Text variant="error" size="sm">
          <span data-testid="tenant-error">{save.error.message}</span>
        </Text>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={save.isPending}
          disabled={blocked}
          data-testid="tenant-save"
        >
          {mode.kind === 'create' ? 'Create tenant' : 'Save'}
        </Button>
      </div>
    </form>
  )
}

function Row({
  label,
  hint,
  danger = false,
  children,
}: {
  label: string
  hint?: string | undefined
  danger?: boolean
  children: ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Text variant="secondary" size="sm" as="span">
        {label}
      </Text>
      {children}
      {hint && (
        <span className={`text-[12px] ${danger ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
          {hint}
        </span>
      )}
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  testId: string
}) {
  return (
    <Switch
      variant="neutral"
      size="sm"
      label={label}
      checked={checked}
      onCheckedChange={onChange}
      data-testid={testId}
    />
  )
}
