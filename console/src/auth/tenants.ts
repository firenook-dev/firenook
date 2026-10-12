// Tenants as Settings edits them: created with the id you choose through the
// Console API (`POST /auth/tenants`: the official `tenants.create` always
// draws a random id), changed and deleted through the official endpoints
// with the Admin SDK's credential (`PATCH|DELETE …/v2/projects/{p}/tenants/
// {t}`, `x-firenook-console: write`), so each change behaves as it would from
// code and Activity records it.

import type { AuthTenant } from '@/api/generated/auth/AuthTenant'
import type { AuthTenantCreate } from '@/api/generated/auth/AuthTenantCreate'
import { type EmulatorAnswer, callAuthEmulator, createTenant, tenantsPath } from './api'

/** What the console route accepts as a tenant id: a letter, then 3 to 19 letters, digits or hyphens. */
export const TENANT_ID = /^[A-Za-z][A-Za-z0-9-]{3,19}$/

/** The sentence a refused id gets, the engine's own. */
export const TENANT_ID_RULE =
  'A tenant id starts with a letter and holds 4 to 20 letters, digits or hyphens.'

/** A tenant's MFA state, as the API spells it. */
export const MFA_STATES = ['DISABLED', 'ENABLED', 'MANDATORY'] as const
export type MfaState = (typeof MFA_STATES)[number]

export const MFA_STATE_LABELS: Readonly<Record<MfaState, string>> = {
  DISABLED: 'Off',
  ENABLED: 'On',
  MANDATORY: 'Required',
}

/** The tenant form: what the dialog edits. */
export interface TenantForm {
  /** Empty: a random 28-character id, as `tenants.create` draws. */
  tenantId: string
  displayName: string
  allowPasswordSignup: boolean
  enableEmailLinkSignin: boolean
  enableAnonymousUser: boolean
  disableAuth: boolean
  mfaState: MfaState
  /** SMS is the one second factor the emulator has. */
  mfaSms: boolean
}

/** A new tenant: every sign-in method on, as the emulator's own tenants start. */
export const NEW_TENANT: TenantForm = {
  tenantId: '',
  displayName: '',
  allowPasswordSignup: true,
  enableEmailLinkSignin: true,
  enableAnonymousUser: true,
  disableAuth: false,
  mfaState: 'DISABLED',
  mfaSms: true,
}

function mfaState(value: string): MfaState {
  return (MFA_STATES as readonly string[]).includes(value) ? (value as MfaState) : 'DISABLED'
}

/** The form for an existing tenant. */
export function formOfTenant(tenant: AuthTenant): TenantForm {
  return {
    tenantId: tenant.tenantId,
    displayName: tenant.displayName ?? '',
    allowPasswordSignup: tenant.allowPasswordSignup,
    enableEmailLinkSignin: tenant.enableEmailLinkSignin,
    enableAnonymousUser: tenant.enableAnonymousUser,
    disableAuth: tenant.disableAuth,
    mfaState: mfaState(tenant.mfaState),
    mfaSms: tenant.mfaProviders.includes('PHONE_SMS'),
  }
}

/** Why the id cannot be used, or nothing (empty is a generated id). */
export function tenantIdProblem(tenantId: string): string | undefined {
  const id = tenantId.trim()
  if (id === '') return undefined
  return TENANT_ID.test(id) ? undefined : TENANT_ID_RULE
}

/** `POST /auth/tenants`'s body. */
export function createBody(form: TenantForm): AuthTenantCreate {
  const body: AuthTenantCreate = {
    allowPasswordSignup: form.allowPasswordSignup,
    enableEmailLinkSignin: form.enableEmailLinkSignin,
    enableAnonymousUser: form.enableAnonymousUser,
    disableAuth: form.disableAuth,
    mfaState: form.mfaState,
    mfaProviders: form.mfaSms ? ['PHONE_SMS'] : [],
  }
  if (form.tenantId.trim() !== '') body.tenantId = form.tenantId.trim()
  if (form.displayName.trim() !== '') body.displayName = form.displayName.trim()
  return body
}

/** Creates a tenant with the id the form names, or a generated one. */
export function createFromForm(project: string, form: TenantForm): Promise<AuthTenant> {
  return createTenant(project, createBody(form))
}

/** The fields an edit changed, as `tenants.patch` takes them: the body and its `updateMask`. */
export function patchOf(
  before: TenantForm,
  after: TenantForm,
): { body: Record<string, unknown>; updateMask: string } | undefined {
  const body: Record<string, unknown> = {}
  const mask: string[] = []
  const flat = [
    'displayName',
    'allowPasswordSignup',
    'enableEmailLinkSignin',
    'enableAnonymousUser',
    'disableAuth',
  ] as const
  for (const field of flat) {
    const value = field === 'displayName' ? after.displayName.trim() : after[field]
    const was = field === 'displayName' ? before.displayName.trim() : before[field]
    if (value === was) continue
    body[field] = value
    mask.push(field)
  }
  if (before.mfaState !== after.mfaState || before.mfaSms !== after.mfaSms) {
    body.mfaConfig = { state: after.mfaState, enabledProviders: after.mfaSms ? ['PHONE_SMS'] : [] }
    mask.push('mfaConfig.state', 'mfaConfig.enabledProviders')
  }
  return mask.length === 0 ? undefined : { body, updateMask: mask.join(',') }
}

/** Changes a tenant through the official endpoint, as the Admin SDK does. */
export function updateTenant(
  project: string,
  tenantId: string,
  patch: { body: Record<string, unknown>; updateMask: string },
): Promise<EmulatorAnswer<unknown>> {
  return callAuthEmulator({
    method: 'PATCH',
    path: tenantsPath(project, tenantId),
    query: { updateMask: patch.updateMask },
    body: patch.body,
    as: 'admin',
    origin: 'write',
  })
}

/** Deletes a tenant and every user in it (no `user.delete` events), as the Admin SDK does. */
export function deleteTenant(project: string, tenantId: string): Promise<EmulatorAnswer<unknown>> {
  return callAuthEmulator({
    method: 'DELETE',
    path: tenantsPath(project, tenantId),
    as: 'admin',
    origin: 'write',
  })
}

/** "password · link · anonymous · MFA on": a tenant's sign-in methods, as the table lists them. */
export function signInSummary(
  tenant: Pick<
    AuthTenant,
    | 'allowPasswordSignup'
    | 'enableEmailLinkSignin'
    | 'enableAnonymousUser'
    | 'disableAuth'
    | 'mfaState'
  >,
): string {
  if (tenant.disableAuth) return 'sign-in turned off'
  const methods: string[] = []
  if (tenant.allowPasswordSignup) methods.push('password')
  if (tenant.enableEmailLinkSignin) methods.push('link')
  if (tenant.enableAnonymousUser) methods.push('anonymous')
  const state = mfaState(tenant.mfaState)
  if (state !== 'DISABLED') methods.push(state === 'MANDATORY' ? 'MFA required' : 'MFA on')
  return methods.length > 0 ? methods.join(' · ') : 'no sign-in method'
}
