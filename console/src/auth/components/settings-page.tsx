// Authentication's settings, as one document: how sign-in behaves (the
// project's one-account-per-email and email enumeration protection, or a
// tenant's sign-in methods and multi-factor state), the tenants, the
// blocking functions and triggers, where the section's data goes in and
// out (the Users page's dialogs, the Overview's reset), where the snippets
// that connect an app are (the Overview's), and the production settings the
// emulator does not apply — stated as facts, never as controls. Every change goes through the official API as
// the Admin SDK makes it (`x-firenook-console: write`), and `auth.config`
// keeps every open page in step.

import { Button, LayerCard, Select, Switch, Text } from '@cloudflare/kumo'
import { BuildingsIcon, EnvelopeSimpleIcon, PlusIcon, ShieldCheckIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { AuthTenant } from '@/api/generated/auth/AuthTenant'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { SectionBanner } from '@/components/console/section-banner'
import { SectionPage } from '@/components/console/section-page'
import { Page } from '@/components/shell/page'
import { formatCount } from '@/lib/format'
import { useConsoleProject } from '@/lib/project'
import { useRouteSearch } from '@/lib/search-params'
import { useShortcuts } from '@/lib/shortcuts'
import { updateEmulatorConfig } from '../api'
import { useConfigLive } from '../live'
import { authKeys, projectConfigQuery, tenantQuery } from '../queries'
import { type TenantScope, tenantParam, tenantScope } from '../tenant-scope'
import {
  MFA_STATES,
  MFA_STATE_LABELS,
  type MfaState,
  type TenantForm,
  deleteTenant,
  formOfTenant,
  patchOf,
  updateTenant,
} from '../tenants'
import { HooksCard } from './hooks-card'
import { usePagePalette } from './page-palette'
import { TenantDialog, type TenantDialogMode } from './tenant-dialog'
import { TenantPicker } from './tenant-picker'
import { TenantsTable } from './tenants-table'

/** The Settings page's search params (`routes/auth_.settings.tsx`). */
export type SettingsSearch = {
  project?: string | undefined
  section?: 'sign-in' | 'tenants' | 'hooks' | 'data' | 'connect' | undefined
  tenant?: string | undefined
  new?: 'tenant' | undefined
}

/** What production Firebase applies that the emulator does not, said once. */
export const NOT_EMULATED =
  'Email and SMS templates, authorized domains, the password policy, the SMS region policy, the sign-up quota, reCAPTCHA, TOTP second factors, beforeSendEmail and beforeSendSms, and per-provider switches at the project level. Your app behaves as if they were off.'

export function SettingsPage() {
  const { search, update } = useRouteSearch<SettingsSearch>('/auth_/settings', '/auth/settings')
  const { project } = useConsoleProject()
  const scope = tenantScope('settings', search.tenant)
  const navigate = useNavigate()
  const [tenants, setTenants] = useState<number | undefined>(undefined)
  const [editing, setEditing] = useState<AuthTenant | undefined>(undefined)
  const [deleting, setDeleting] = useState<AuthTenant | undefined>(undefined)
  const queryClient = useQueryClient()
  useConfigLive(project)

  const setScope = (next: TenantScope) =>
    update({ tenant: tenantParam('settings', next) }, { replace: true })
  const dialog: TenantDialogMode | undefined =
    search.new === 'tenant'
      ? { kind: 'create' }
      : editing
        ? { kind: 'edit', tenant: editing }
        : undefined

  // `?section=` brings its card into view as the page opens, and again when
  // it names another card (the tenant picker's Manage tenants… does), never
  // on the page's own changes to the address.
  const scrolled = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!search.section || scrolled.current === search.section) return
    scrolled.current = search.section
    document.getElementById(`auth-settings-${search.section}`)?.scrollIntoView({ block: 'start' })
  }, [search.section])

  const remove = useMutation({
    mutationFn: (tenant: AuthTenant) => deleteTenant(project, tenant.tenantId),
    onSuccess: (_answer, tenant) => {
      void queryClient.invalidateQueries({ queryKey: authKeys.allTenantPicker(project) })
      if (scope.kind === 'tenant' && scope.tenant === tenant.tenantId) setScope({ kind: 'project' })
      setDeleting(undefined)
    },
  })

  const config = useQuery({
    ...projectConfigQuery(project),
    enabled: project !== '' && scope.kind === 'project',
  })
  const setConfig = useMutation({
    mutationFn: (change: {
      allowDuplicateEmails?: boolean
      enableImprovedEmailPrivacy?: boolean
    }) => updateEmulatorConfig(project, change),
    onSuccess: (answer) => queryClient.setQueryData(authKeys.config(project, ''), answer),
  })
  useShortcuts({ id: 'auth.settings', label: 'Settings' }, [
    { key: 'n', label: 'New tenant', group: 'Settings', run: () => update({ new: 'tenant' }) },
  ])
  usePagePalette('auth.settings', 'Authentication settings', () => {
    const items = [
      {
        id: 'auth.settings.new-tenant',
        title: 'Create a tenant',
        icon: <BuildingsIcon size={16} />,
        run: () => update({ new: 'tenant' }),
      },
    ]
    const current = config.data
    if (scope.kind === 'project' && current)
      items.push(
        {
          id: 'auth.settings.one-account',
          title: current.signIn.allowDuplicateEmails
            ? 'Turn on one account per email address'
            : 'Turn off one account per email address',
          icon: <EnvelopeSimpleIcon size={16} />,
          run: () =>
            setConfig.mutate({ allowDuplicateEmails: !current.signIn.allowDuplicateEmails }),
        },
        {
          id: 'auth.settings.enumeration',
          title: current.emailPrivacyConfig.enableImprovedEmailPrivacy
            ? 'Turn off email enumeration protection'
            : 'Turn on email enumeration protection',
          icon: <ShieldCheckIcon size={16} />,
          run: () =>
            setConfig.mutate({
              enableImprovedEmailPrivacy: !current.emailPrivacyConfig.enableImprovedEmailPrivacy,
            }),
        },
      )
    return items
  })

  return (
    <SectionPage
      section="auth"
      page="settings"
      title="Authentication settings"
      testId="auth-settings"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Page className="mx-auto grid w-full max-w-[960px] gap-8 pb-12">
          <Text variant="heading" size="lg" as="h2">
            Authentication settings
          </Text>
          <Card
            id="sign-in"
            title="Sign-in behaviour"
            action={
              <div className="w-64 min-w-0">
                <TenantPicker
                  project={project}
                  page="settings"
                  scope={scope}
                  onChange={setScope}
                  testId="settings-tenant"
                />
              </div>
            }
          >
            {scope.kind === 'tenant' ? (
              <TenantSignIn
                project={project}
                tenant={scope.tenant}
                onGone={() => setScope({ kind: 'project' })}
              />
            ) : (
              <ProjectSignIn
                config={config.data}
                error={config.error ?? setConfig.error}
                pending={setConfig.isPending}
                onChange={(change) => setConfig.mutate(change)}
              />
            )}
          </Card>
          <Card
            id="tenants"
            title={
              tenants === undefined ? 'Tenants' : `Tenants · ${tenants === 0 ? 'none' : tenants}`
            }
            plain
            action={
              <Button
                variant="secondary"
                size="sm"
                icon={<PlusIcon />}
                onClick={() => update({ new: 'tenant' })}
                data-testid="settings-new-tenant"
              >
                New tenant
              </Button>
            }
          >
            <TenantsTable
              project={project}
              onEdit={setEditing}
              onDelete={setDeleting}
              onShowSettings={(tenant) => {
                setScope({ kind: 'tenant', tenant: tenant.tenantId })
                document.getElementById('auth-settings-sign-in')?.scrollIntoView({ block: 'start' })
              }}
              onShowUsers={(tenant) =>
                void navigate({
                  to: '/auth' as never,
                  search: {
                    tenant: tenant.tenantId,
                    ...(search.project ? { project: search.project } : {}),
                  } as never,
                })
              }
              onCount={setTenants}
            />
          </Card>
          <Card id="hooks" title="Blocking functions and triggers">
            <HooksCard
              project={project}
              tenant={scope.kind === 'tenant' ? scope.tenant : undefined}
            />
          </Card>
          <Card id="data" title="Data" plain>
            <DataLinks
              tenant={scope.kind === 'tenant' ? scope.tenant : undefined}
              project={search.project}
            />
          </Card>
          <Card id="connect" title="Connect your app" plain>
            <p className="m-0 text-[14px] text-kumo-subtle" data-testid="settings-connect-note">
              The snippets that point an app at this Auth emulator, for the web, Flutter, Apple,
              Android, the Admin SDKs and environment variables, are under{' '}
              <Link
                to="."
                search={(previous) => ({ ...previous, connect: 'web' as const })}
                className={TEXT_LINK}
                data-testid="settings-connect-open"
              >
                Connect
              </Link>{' '}
              in the top bar, with this engine&apos;s host and ports.
            </p>
          </Card>
          <Card id="production" title="Production settings the emulator does not apply" plain>
            <Text variant="secondary">{NOT_EMULATED}</Text>
          </Card>
        </Page>
      </div>
      <TenantDialog
        project={project}
        mode={dialog}
        onClose={() => {
          setEditing(undefined)
          if (search.new) update({ new: undefined }, { replace: true })
        }}
        onCreated={(tenant) => setScope({ kind: 'tenant', tenant: tenant.tenantId })}
      />
      <DangerConfirm
        open={deleting !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setDeleting(undefined)
            remove.reset()
          }
        }}
        title={`Delete tenant ${deleting?.tenantId ?? ''}`}
        description={
          deleting && deleting.users > 0
            ? `Its ${formatCount(deleting.users, { one: 'user is', other: 'users are' })} removed with it.`
            : 'It holds no users.'
        }
        consequences={['No user.delete events fire, as when the Admin SDK deletes a tenant.']}
        pending={remove.isPending}
        {...(remove.error instanceof Error ? { error: remove.error.message } : {})}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting)
        }}
        testId="tenant-delete-confirm"
      />
    </SectionPage>
  )
}

/** A link in the page's sentences: the console's link colour, underlined on hover. */
const TEXT_LINK =
  'text-kumo-link underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none'

/**
 * Where the section's data goes in and out: the Users page's Export, Import
 * and Sample users dialogs (for the tenant shown), and the Overview's
 * reset, which deletes every user of every tenant as one suite job.
 */
function DataLinks({
  tenant,
  project,
}: {
  tenant: string | undefined
  /** `?project=`, when the page shows another project. */
  project: string | undefined
}) {
  const users = (open: { dialog: 'export' } | { new: 'import' | 'sample' }) => ({
    ...open,
    ...(tenant ? { tenant } : {}),
    ...(project ? { project } : {}),
  })
  return (
    <p className="m-0 text-[14px] text-kumo-subtle" data-testid="settings-data-links">
      Users go in and out on the Users page:{' '}
      <Link
        to="/auth"
        search={users({ dialog: 'export' }) as never}
        className={TEXT_LINK}
        data-testid="settings-export"
      >
        Export users
      </Link>
      ,{' '}
      <Link
        to="/auth"
        search={users({ new: 'import' }) as never}
        className={TEXT_LINK}
        data-testid="settings-import"
      >
        Import users
      </Link>{' '}
      and{' '}
      <Link
        to="/auth"
        search={users({ new: 'sample' }) as never}
        className={TEXT_LINK}
        data-testid="settings-sample"
      >
        Add sample users
      </Link>
      . To delete every user of every tenant, reset Authentication on the{' '}
      <Link
        to="/"
        search={{ dialog: 'reset', section: 'auth' }}
        className={TEXT_LINK}
        data-testid="settings-reset"
      >
        Overview ↗
      </Link>
      .
    </p>
  )
}

/** One part of the page: its title (16 px) and controls over its card. */
function Card({
  id,
  title,
  action,
  plain = false,
  children,
}: {
  id: string
  title: string
  action?: ReactNode
  /** Without the card's frame: the tenants table has its own, the last section is a sentence. */
  plain?: boolean
  children: ReactNode
}) {
  return (
    <section
      id={`auth-settings-${id}`}
      className="grid scroll-mt-4 gap-3"
      aria-label={title}
      data-testid={`settings-${id}`}
    >
      <div className="flex min-h-8 items-center justify-between gap-4">
        <Text variant="heading" as="h3">
          {title}
        </Text>
        {action}
      </div>
      {plain ? children : <LayerCard className="px-5 py-4">{children}</LayerCard>}
    </section>
  )
}

/** A switch of the page, its name, and what it does in a sentence under it. */
function SettingRow({
  label,
  description,
  control,
  testId,
}: {
  label: string
  description: ReactNode
  control: ReactNode
  testId?: string
}) {
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-1 py-3 first:pt-0 last:pb-0"
      data-testid={testId}
    >
      <span className="text-[14px] text-kumo-default">{label}</span>
      <span className="row-span-2 flex items-center pt-0.5">{control}</span>
      <span className="text-[13px] text-kumo-subtle">{description}</span>
    </div>
  )
}

function ProjectSignIn({
  config,
  error,
  pending,
  onChange,
}: {
  config:
    | {
        signIn: { allowDuplicateEmails: boolean }
        emailPrivacyConfig: { enableImprovedEmailPrivacy: boolean }
      }
    | undefined
  error: Error | null
  pending: boolean
  onChange: (change: {
    allowDuplicateEmails?: boolean
    enableImprovedEmailPrivacy?: boolean
  }) => void
}) {
  return (
    <div className="grid divide-y divide-kumo-line">
      <SettingRow
        label="One account per email address"
        description="On: an email already used by an account is refused for a new one (EMAIL_EXISTS). Off: several accounts may share an email, one per sign-in provider."
        control={
          <Switch
            variant="neutral"
            checked={config ? !config.signIn.allowDuplicateEmails : false}
            disabled={!config || pending}
            onCheckedChange={(checked) => onChange({ allowDuplicateEmails: !checked })}
            aria-label="One account per email address"
            data-testid="settings-one-account"
          />
        }
      />
      <SettingRow
        label="Email enumeration protection"
        description="On: a wrong password and an unknown email both answer INVALID_LOGIN_CREDENTIALS, so a sign-in form says nothing about which accounts exist."
        control={
          <Switch
            variant="neutral"
            checked={config?.emailPrivacyConfig.enableImprovedEmailPrivacy ?? false}
            disabled={!config || pending}
            onCheckedChange={(checked) => onChange({ enableImprovedEmailPrivacy: checked })}
            aria-label="Email enumeration protection"
            data-testid="settings-enumeration"
          />
        }
      />
      <SettingRow
        label="SMS multi-factor"
        description="Always on for the project’s own users in the emulator; a tenant turns it on or off for its users."
        control={<span className="text-[13px] text-kumo-subtle">On</span>}
      />
      {error && (
        <p className="m-0 pt-3 text-[13px] text-kumo-danger" data-testid="settings-error">
          {error.message}
        </p>
      )}
    </div>
  )
}

function TenantSignIn({
  project,
  tenant,
  onGone,
}: {
  project: string
  tenant: string
  onGone: () => void
}) {
  const queryClient = useQueryClient()
  const current = useQuery({ ...tenantQuery(project, tenant), enabled: project !== '' })
  const save = useMutation({
    mutationFn: async (next: TenantForm) => {
      if (!current.data) return
      const patch = patchOf(formOfTenant(current.data), next)
      if (patch) await updateTenant(project, tenant, patch)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: authKeys.config(project, tenant) })
      void queryClient.invalidateQueries({ queryKey: authKeys.allTenants(project) })
    },
  })
  if (current.data === null)
    return (
      <div className="-mx-5 -my-4 overflow-hidden rounded-lg">
        <SectionBanner
          tone="danger"
          testId="settings-tenant-gone"
          action={
            <Button variant="secondary" size="xs" onClick={onGone}>
              Show project settings
            </Button>
          }
        >
          There is no tenant <span className="font-mono text-[0.9em]">{tenant}</span> in this
          project.
        </SectionBanner>
      </div>
    )
  const form = current.data ? formOfTenant(current.data) : undefined
  const change = (patch: Partial<TenantForm>) => {
    if (form) save.mutate({ ...form, ...patch })
  }
  const busy = !form || save.isPending
  const toggle = (
    label: string,
    description: string,
    key: keyof TenantForm,
    testId: string,
    invert = false,
  ) => (
    <SettingRow
      label={label}
      description={description}
      testId={testId}
      control={
        <Switch
          variant="neutral"
          checked={form ? (invert ? !form[key] : Boolean(form[key])) : false}
          disabled={busy}
          onCheckedChange={(checked) => change({ [key]: invert ? !checked : checked })}
          aria-label={label}
        />
      }
    />
  )
  return (
    <div className="grid divide-y divide-kumo-line" data-testid="settings-tenant-sign-in">
      {toggle(
        'Password sign-up',
        'Off: a password sign-in answers PASSWORD_LOGIN_DISABLED, and a password sign-up OPERATION_NOT_ALLOWED.',
        'allowPasswordSignup',
        'settings-tenant-password',
      )}
      {toggle(
        'Email link sign-in',
        'Off: sign-in links are refused with OPERATION_NOT_ALLOWED.',
        'enableEmailLinkSignin',
        'settings-tenant-link',
      )}
      {toggle(
        'Anonymous sign-in',
        'Off: signInAnonymously answers ADMIN_ONLY_OPERATION.',
        'enableAnonymousUser',
        'settings-tenant-anonymous',
      )}
      {toggle(
        'Sign-in on',
        'Off (disableAuth): every sign-in of this tenant answers PROJECT_DISABLED.',
        'disableAuth',
        'settings-tenant-enabled',
        true,
      )}
      <SettingRow
        label="Multi-factor authentication"
        description="Required: users without a second factor cannot finish signing in. SMS is the second factor the emulator has."
        testId="settings-tenant-mfa"
        control={
          <Select
            size="sm"
            value={form?.mfaState ?? 'DISABLED'}
            onValueChange={(next) => change({ mfaState: next as MfaState, mfaSms: true })}
            items={Object.fromEntries(MFA_STATES.map((state) => [state, MFA_STATE_LABELS[state]]))}
            disabled={busy}
            aria-label="Multi-factor authentication"
            className="w-32"
          />
        }
      />
      <p className="m-0 pt-3 text-[13px] text-kumo-subtle">
        One account per email and email enumeration protection are the project’s: choose No tenant
        to change them.
      </p>
      {save.error && (
        <p className="m-0 pt-3 text-[13px] text-kumo-danger" data-testid="settings-error">
          {save.error.message}
        </p>
      )}
    </div>
  )
}
