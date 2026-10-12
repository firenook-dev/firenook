// Which tenant a page shows: "Tenant acme ▾" at the head of the filters
// panel (and of the toolbar while the panel is hidden), "Tenant No tenant ▾"
// on Settings. The Firestore database picker's shape (`ScopeSelect`): `xs`,
// so its text matches the 12 px filter under it, named inside the box —
// a muted word and the value — and `min-w-0`, so a long id never pushes the
// caret out of sight. A tenant id is data, so it is the data face; "All
// tenants" and "No tenant" are English.
//
// Every tenant's user count is in the open list only: the closed box says
// which tenant, never how many (the toolbar's count says that once). Above
// 20 tenants the list is a search instead — the engine filters by id and
// display name (`GET /auth/tenants?q=`), at most 50 are listed, and the last
// row says how many more there are to narrow to. The list is read again
// each time it opens, so a tenant created since the page loaded is in it;
// opening never creates one. Its last two rows lead to Settings: New
// tenant… and Manage tenants….

import { Button, Combobox, Select, cn } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { AuthTenant } from '@/api/generated/auth/AuthTenant'
import type { AuthTenantPage } from '@/api/generated/auth/AuthTenantPage'
import { formatCount } from '@/lib/format'
import { tenantPickerQuery } from '../queries'
import type { AuthPage, TenantScope } from '../tenant-scope'

/** Above this many tenants the picker searches the engine instead of listing them all. */
export const SEARCH_ABOVE = 20

const USERS = { one: 'user', other: 'users' }

/**
 * The picker's value for each scope: the tenant's id, or a word no tenant id
 * can be (they hold no NUL) for every tenant and for the project's users. A
 * select reads an empty value as no value at all, so `''` is never one.
 */
const ALL = '\u0000all'
const PROJECT = '\u0000project'

/** A scope as the picker's value. */
export function pickerValue(scope: TenantScope): string {
  if (scope.kind === 'all') return ALL
  if (scope.kind === 'project') return PROJECT
  return scope.tenant
}
/** The two rows that lead to Settings; tenant ids never hold a NUL. */
const NEW = '\u0000new'
const MANAGE = '\u0000manage'

/** How a scope reads in the closed box and as a list row. */
export function scopeLabel(scope: TenantScope): { text: string; data: boolean } {
  if (scope.kind === 'all') return { text: 'All tenants', data: false }
  if (scope.kind === 'project') return { text: 'No tenant', data: false }
  return { text: scope.tenant, data: true }
}

function scopeOf(value: string): TenantScope {
  if (value === ALL) return { kind: 'all' }
  if (value === PROJECT) return { kind: 'project' }
  return { kind: 'tenant', tenant: value }
}

/** One row of the open list. */
export interface TenantItem {
  value: string
  /** What the row says first: "All tenants", "No tenant — project users", a display name or an id. */
  title: string
  /** The tenant id beside a display name, in the data face. */
  id?: string | undefined
  /** "5 users". */
  detail?: string | undefined
}

/**
 * The rows of the list: every tenant (on Inbox and Activity), the project's
 * own users, then the tenants the engine answered — and the tenant in scope
 * even when the engine no longer lists it, so the box never shows a value
 * its own list cannot pick.
 */
export function tenantItems(
  page: AuthPage,
  answer: AuthTenantPage | undefined,
  current: TenantScope,
): TenantItem[] {
  const items: TenantItem[] = []
  if (page === 'inbox' || page === 'activity') items.push({ value: ALL, title: 'All tenants' })
  items.push({
    value: PROJECT,
    title: 'No tenant — project users',
    detail:
      answer?.projectUsers === null || answer?.projectUsers === undefined
        ? undefined
        : formatCount(answer.projectUsers, USERS),
  })
  for (const tenant of answer?.items ?? []) items.push(tenantRow(tenant))
  if (current.kind === 'tenant' && !items.some((item) => item.value === current.tenant))
    items.push({ value: current.tenant, title: current.tenant })
  return items
}

function tenantRow(tenant: AuthTenant): TenantItem {
  const named = tenant.displayName !== null && tenant.displayName !== ''
  return {
    value: tenant.tenantId,
    title: named ? (tenant.displayName ?? tenant.tenantId) : tenant.tenantId,
    id: named ? tenant.tenantId : undefined,
    detail: formatCount(tenant.users, USERS),
  }
}

/** "12 more — type to narrow", when the engine holds more tenants than are listed. */
export function moreText(answer: AuthTenantPage | undefined): string | undefined {
  const total = answer?.total?.count
  const shown = answer?.items.length ?? 0
  if (total === undefined || total <= shown) return undefined
  return `${formatCount(total - shown, { one: 'more', other: 'more' })} — type to narrow`
}

export function TenantPicker({
  project,
  page,
  value,
  onChange,
  testId = 'tenant-picker',
  className,
}: {
  project: string
  /** Inbox and Activity offer every tenant at once; Users and Settings show one scope. */
  page: AuthPage
  value: TenantScope
  onChange: (scope: TenantScope) => void
  testId?: string
  className?: string
}) {
  const first = useQuery({ ...tenantPickerQuery(project), enabled: project !== '' })
  const many = (first.data?.total?.count ?? 0) > SEARCH_ABOVE
  const navigate = useNavigate()
  const { project: shown } = useConsoleProjectParam()
  const toSettings = (search: Record<string, string>) =>
    void navigate({
      to: '/auth/settings',
      search: { ...search, ...(shown ? { project: shown } : {}) } as never,
    })
  const settings = {
    onNew: () => toSettings({ new: 'tenant' }),
    onManage: () => toSettings({ section: 'tenants' }),
  }
  return (
    <div className={cn('min-w-0', className)} data-testid={testId}>
      {many ? (
        <TenantSearch
          project={project}
          page={page}
          value={value}
          onChange={onChange}
          {...settings}
        />
      ) : (
        <TenantSelect
          page={page}
          value={value}
          onChange={onChange}
          answer={first.data}
          onOpen={() => void first.refetch()}
          {...settings}
        />
      )}
    </div>
  )
}

/** The `project` param the page's address carries, kept on the way to Settings. */
function useConsoleProjectParam(): { project: string | undefined } {
  const requested = useRouterState({
    select: (state) => {
      const value = (state.location.search as Record<string, unknown>).project
      return typeof value === 'string' && value !== '' ? value : undefined
    },
  })
  return { project: requested }
}

function BoxValue({ scope }: { scope: TenantScope }) {
  const label = scopeLabel(scope)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-kumo-subtle">Tenant</span>
      <span className={cn('truncate', label.data && 'font-mono')} data-testid="tenant-picker-value">
        {label.text}
      </span>
    </span>
  )
}

function ItemText({ item }: { item: TenantItem }) {
  // A tenant without a display name is its id: data. The two words of the
  // scopes are English.
  const data = item.id === undefined && item.value !== ALL && item.value !== PROJECT
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className={cn('truncate text-[12px]', data && 'font-mono')}>{item.title}</span>
      {item.id !== undefined && (
        <span className="truncate font-mono text-[11px] text-kumo-subtle">{item.id}</span>
      )}
      {item.detail !== undefined && (
        <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] text-kumo-subtle tabular-nums">
          {item.detail}
        </span>
      )}
    </span>
  )
}

function TenantSelect({
  page,
  value,
  onChange,
  answer,
  onOpen,
  onNew,
  onManage,
}: {
  page: AuthPage
  value: TenantScope
  onChange: (scope: TenantScope) => void
  answer: AuthTenantPage | undefined
  onOpen: () => void
  onNew: () => void
  onManage: () => void
}) {
  const items = tenantItems(page, answer, value)
  return (
    <Select
      size="xs"
      value={pickerValue(value)}
      onValueChange={(next) => {
        const picked = String(next)
        if (picked === NEW) onNew()
        else if (picked === MANAGE) onManage()
        else onChange(scopeOf(picked))
      }}
      onOpenChange={(open) => {
        if (open) onOpen()
      }}
      renderValue={() => <BoxValue scope={value} />}
      aria-label="Tenant"
      className="h-6.5 w-full min-w-0 rounded-md"
    >
      {items.map((item) => (
        <Select.Option key={item.value} value={item.value}>
          <ItemText item={item} />
        </Select.Option>
      ))}
      <Select.Separator />
      <Select.Option value={NEW}>
        <span className="text-[12px]">New tenant…</span>
      </Select.Option>
      {page !== 'settings' && (
        <Select.Option value={MANAGE}>
          <span className="text-[12px]">Manage tenants…</span>
        </Select.Option>
      )}
    </Select>
  )
}

/** The searchable form: what is typed goes to the engine, 150 ms after the last key. */
function TenantSearch({
  project,
  page,
  value,
  onChange,
  onNew,
  onManage,
}: {
  project: string
  page: AuthPage
  value: TenantScope
  onChange: (scope: TenantScope) => void
  onNew: () => void
  onManage: () => void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [settled, setSettled] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(text.trim()), 150)
    return () => window.clearTimeout(timer)
  }, [text])
  const found = useQuery({
    ...tenantPickerQuery(project, settled),
    enabled: open && project !== '',
    placeholderData: (previous) => previous,
  })
  const items = tenantItems(page, found.data, value)
  const more = moreText(found.data)
  const selected = items.find((item) => item.value === pickerValue(value)) ?? null
  return (
    <Combobox
      size="xs"
      items={items}
      value={selected}
      // The engine filters; the list shows what it answered.
      filter={null}
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        if (next) void found.refetch()
        else setText('')
      }}
      inputValue={text}
      onInputValueChange={(next: string) => setText(next)}
      itemToStringLabel={(item: TenantItem) => item.title}
      isItemEqualToValue={(item: TenantItem, current: TenantItem) => item.value === current.value}
      onValueChange={(next: unknown) => {
        const item = next as TenantItem | null
        if (item) onChange(scopeOf(item.value))
      }}
    >
      <Combobox.TriggerValue aria-label="Tenant" className="h-6.5 w-full min-w-0 rounded-md">
        {() => <BoxValue scope={value} />}
      </Combobox.TriggerValue>
      <Combobox.Content className="w-[300px]">
        <Combobox.Input placeholder="Find a tenant by id or name" />
        <Combobox.Empty>No tenant matches.</Combobox.Empty>
        <Combobox.List>
          {(item: TenantItem) => (
            <Combobox.Item key={item.value} value={item}>
              <ItemText item={item} />
            </Combobox.Item>
          )}
        </Combobox.List>
        {more && (
          <div
            className="border-t border-kumo-line px-3 py-1.5 text-[12px] text-kumo-subtle"
            data-testid="tenant-picker-more"
          >
            {more}
          </div>
        )}
        <div className="flex items-center gap-1 border-t border-kumo-line p-1">
          <Button variant="ghost" size="xs" onClick={onNew}>
            New tenant…
          </Button>
          {page !== 'settings' && (
            <Button variant="ghost" size="xs" onClick={onManage}>
              Manage tenants…
            </Button>
          )}
        </div>
      </Combobox.Content>
    </Combobox>
  )
}
