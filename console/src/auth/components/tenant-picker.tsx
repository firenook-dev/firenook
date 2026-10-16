// Which tenant a page shows: "Tenant acme ▾" at the head of the panel, and
// at the head of the toolbar while the panel is hidden, so a developer who
// hid the panel still sees which tenant a new user goes to. The closed box
// shows the tenant, never a figure; the open list shows each tenant's
// display name, id and user count, then "New tenant…" and "Manage
// tenants…". Past 20 tenants it becomes a search: typing asks the engine,
// which filters by id and display name, and at most 50 are listed.
//
// It reads `GET /auth/tenants` (never creating a tenant by asking) and asks
// again each time it opens, so a tenant created since the page mounted is
// in the list.

import { Combobox } from '@cloudflare/kumo'
import { BuildingsIcon, GearSixIcon, PlusIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { AuthTenantList } from '@/api/generated/auth/AuthTenantList'
import { type ScopeAction, type ScopeItem, ScopeSelect } from '@/components/console/scope-select'
import { formatCount, formatNumber } from '@/lib/format'
import { authKeys, tenantPickerQuery } from '../queries'
import {
  ALL_TENANTS,
  type AuthPage,
  NO_TENANT,
  type TenantScope,
  projectParam,
  tenantScope,
} from '../tenant-scope'

/** Past this many tenants the picker is a search rather than a list. */
export const PICKER_LIST_MAX = 20

const USERS = { one: 'user', other: 'users' }

/** The picker's value for a scope: a tenant id, `(none)` for project users, `(all)` for every tenant. */
export function scopeValue(scope: TenantScope): string {
  if (scope.kind === 'tenant') return scope.tenant
  return scope.kind === 'all' ? ALL_TENANTS : NO_TENANT
}

/** The list a page's picker offers, from the engine's first tenants. */
export function pickerItems(
  page: AuthPage,
  answer: Pick<AuthTenantList, 'items' | 'projectUsers'> | undefined,
): ScopeItem<string>[] {
  const items: ScopeItem<string>[] = []
  if (page === 'inbox' || page === 'activity')
    items.push({ value: ALL_TENANTS, label: 'All tenants' })
  items.push({
    value: NO_TENANT,
    label: 'No tenant',
    note: 'Project users',
    detail: answer === undefined ? undefined : formatCount(answer.projectUsers, USERS),
  })
  for (const tenant of answer?.items ?? [])
    items.push({
      value: tenant.tenantId,
      label: tenant.tenantId,
      note: tenant.displayName ?? undefined,
      detail: formatCount(tenant.users, USERS),
    })
  return items
}

/** How the box names a scope: the tenant id, "No tenant", "All tenants". */
export function scopeLabel(scope: TenantScope): string {
  if (scope.kind === 'tenant') return scope.tenant
  return scope.kind === 'all' ? 'All tenants' : 'No tenant'
}

export function TenantPicker({
  project,
  page,
  scope,
  onChange,
  testId = 'tenant-picker',
}: {
  project: string
  page: AuthPage
  scope: TenantScope
  onChange: (scope: TenantScope) => void
  testId?: string
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const first = useQuery({ ...tenantPickerQuery(project), enabled: project !== '' })
  const settings = (search: Record<string, string>) =>
    void navigate({
      to: '/auth/settings' as never,
      search: { ...search, project: projectParam(project) } as never,
    })
  const actions: ScopeAction[] = [
    {
      id: 'new-tenant',
      label: 'New tenant…',
      icon: PlusIcon,
      run: () => settings({ new: 'tenant' }),
    },
    {
      id: 'manage-tenants',
      label: 'Manage tenants…',
      icon: GearSixIcon,
      run: () => settings({ section: 'tenants' }),
    },
  ]
  const count = first.data?.total ?? 0
  if (count > PICKER_LIST_MAX)
    return (
      <TenantSearch
        project={project}
        page={page}
        scope={scope}
        onChange={onChange}
        first={first.data}
        actions={actions}
        testId={testId}
      />
    )
  return (
    <ScopeSelect
      label="Tenant"
      value={scopeValue(scope)}
      items={pickerItems(page, first.data)}
      onChange={(value) => onChange(tenantScope(page, value))}
      onOpen={() =>
        void queryClient.invalidateQueries({ queryKey: authKeys.allTenantPicker(project) })
      }
      actions={actions}
      ariaLabel="Tenant"
      testId={testId}
    />
  )
}

/** One row of the search form. */
interface TenantOption {
  value: string
  label: string
  note?: string | undefined
  detail?: string | undefined
}

function optionsOf(
  page: AuthPage,
  answer: AuthTenantList | undefined,
  text: string,
): TenantOption[] {
  const all = pickerItems(page, answer).map((item) => ({
    value: item.value,
    label: item.label ?? item.value,
    note: item.note,
    detail: item.detail,
  }))
  // The fixed rows stay findable by their words; tenants are the engine's answer for the text.
  const typed = text.trim().toLowerCase()
  return all.filter((option) =>
    option.value !== ALL_TENANTS && option.value !== NO_TENANT
      ? true
      : typed === '' || `${option.label} ${option.note ?? ''}`.toLowerCase().includes(typed),
  )
}

function TenantSearch({
  project,
  page,
  scope,
  onChange,
  first,
  actions,
  testId,
}: {
  project: string
  page: AuthPage
  scope: TenantScope
  onChange: (scope: TenantScope) => void
  first: AuthTenantList | undefined
  actions: readonly ScopeAction[]
  testId: string
}) {
  const [text, setText] = useState('')
  const typed = text.trim()
  const found = useQuery({
    ...tenantPickerQuery(project, typed),
    enabled: project !== '' && typed !== '',
  })
  const answer = typed === '' ? first : found.data
  const options = optionsOf(page, answer, typed)
  const value = scopeValue(scope)
  const selected: TenantOption = options.find((option) => option.value === value) ?? {
    value,
    label: scopeLabel(scope),
  }
  const more = answer === undefined ? 0 : Math.max(0, answer.total - answer.items.length)
  return (
    <div className="min-w-0" data-testid={testId}>
      <Combobox<TenantOption>
        size="xs"
        items={options}
        value={selected}
        onValueChange={(next) => {
          const option = next as TenantOption | null
          if (option) onChange(tenantScope(page, option.value))
        }}
        onInputValueChange={(next: string) => setText(next)}
        filter={null}
        itemToStringLabel={(option: TenantOption) => option.label}
        isItemEqualToValue={(item: TenantOption, current: TenantOption) =>
          item.value === current.value
        }
      >
        <Combobox.TriggerValue
          className="h-6.5 w-full min-w-0 rounded-md text-[12px]"
          aria-label="Tenant"
        >
          {() => (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-sans text-kumo-subtle">Tenant</span>
              <span className="truncate font-mono">{scopeLabel(scope)}</span>
            </span>
          )}
        </Combobox.TriggerValue>
        <Combobox.Content className="w-80">
          <Combobox.Input placeholder="Find a tenant by id or name" />
          <Combobox.Empty>No tenant matches.</Combobox.Empty>
          <Combobox.List>
            {(option: TenantOption) => (
              <Combobox.Item key={option.value} value={option}>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {option.value !== ALL_TENANTS && option.value !== NO_TENANT ? (
                    <BuildingsIcon size={14} className="shrink-0 text-kumo-subtle" />
                  ) : null}
                  {option.note && (
                    <span className="min-w-0 truncate font-sans text-[12px]">{option.note}</span>
                  )}
                  <span
                    className={
                      option.note
                        ? 'shrink-0 truncate font-mono text-[12px] text-kumo-subtle'
                        : 'min-w-0 truncate font-mono text-[12px]'
                    }
                  >
                    {option.label}
                  </span>
                  {option.detail && (
                    <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] text-kumo-subtle tabular-nums">
                      {option.detail}
                    </span>
                  )}
                </span>
              </Combobox.Item>
            )}
          </Combobox.List>
          {more > 0 && (
            <div className="px-3 py-1.5 text-[12px] text-kumo-subtle" data-testid="tenant-more">
              {formatNumber(more)} more — type to narrow
            </div>
          )}
          <div className="mt-1 grid border-t border-kumo-line pt-1">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={action.run}
                className="mx-1.5 flex h-7 items-center gap-2 rounded-md px-1.5 text-left text-[13px] hover:ink"
                data-testid={`scope-action-${action.id}`}
              >
                {action.icon && <action.icon size={14} className="shrink-0 text-kumo-subtle" />}
                {action.label}
              </button>
            ))}
          </div>
        </Combobox.Content>
      </Combobox>
    </div>
  )
}
