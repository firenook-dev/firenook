// Who requests run as: Firestore's "view as", the rules playgrounds,
// compute's "Call as", Storage's "As", Cloud Tasks' enqueue. The engine
// applies rules and auth checks to every request, so picking an identity
// shows exactly what that identity's app would get.
//
// It is a menu that names every choice (the SKILL's rule for a mode that
// changes what everything on the page means): the owner, an anonymous
// client, the Auth users — searched on the engine, never every account,
// from every tenant — and a custom identity, any uid and claims minted
// here, so "a user with admin: true" works without an Auth record and
// without Authentication running. A user's requests carry the token the
// Auth emulator itself issues for the account (`resolveAuthorization`).

import { Button, Checkbox, Dialog, DropdownMenu, Input, Select, Text } from '@cloudflare/kumo'
import {
  CaretDownIcon,
  IdentificationBadgeIcon,
  ShieldCheckIcon,
  UserCircleDashedIcon,
  UserIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { ApiError } from '@/api/client'
import { statusQuery } from '@/api/queries'
import { MenuCheck } from '@/components/kit'
import {
  IDENTITY_PAGE,
  type IdentityUser,
  SYNTHETIC_NOTE,
  type ViewAs,
  describeViewAs,
  describeViewAsShort,
  identityUsersQuery,
  userTokenQuery,
  viewAsOfUser,
} from '@/lib/identity'
import { type JsonParse, JsonField } from './json-field'

export type IdentityMode = 'owner' | 'anonymous' | 'user' | 'custom'

const ALL_MODES: readonly IdentityMode[] = ['owner', 'anonymous', 'user', 'custom']

/** Users shown before the list offers a search. */
const SEARCH_AFTER = 8

/** What the trigger says: the qualifier only where there is room for it. */
function labels(value: ViewAs, ownerLabel: string): { long: string; short: string } {
  if (value.kind === 'owner')
    return { long: ownerLabel, short: ownerLabel.replace(/\s*\(.*\)$/, '') }
  return { long: describeViewAs(value), short: describeViewAsShort(value) }
}

function iconOf(kind: ViewAs['kind']) {
  if (kind === 'owner') return <ShieldCheckIcon size={14} />
  if (kind === 'anonymous') return <UserCircleDashedIcon size={14} />
  if (kind === 'custom') return <IdentificationBadgeIcon size={14} />
  return <UserIcon size={14} />
}

function sameUser(value: ViewAs, user: IdentityUser): boolean {
  return value.kind === 'user' && value.uid === user.uid && (value.tenant ?? null) === user.tenant
}

/** The first line of a user's row: how a person knows them. */
function userName(user: IdentityUser): string {
  return user.email ?? user.displayName ?? user.uid
}

export function IdentityPicker({
  project,
  value,
  onChange,
  modes = ALL_MODES,
  ownerLabel = 'Admin (bypasses rules)',
  testId = 'identity-picker',
}: {
  project: string
  value: ViewAs
  onChange: (viewAs: ViewAs) => void
  modes?: readonly IdentityMode[]
  /** How the owner reads where it differs: "Admin (bypasses rules)". */
  ownerLabel?: string
  /** The trigger's test id (Firestore keeps `view-as`); the menu's items carry their own. */
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  // Each opening of the custom form starts from what is in force.
  const [customSession, setCustomSession] = useState(0)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 150)
    return () => window.clearTimeout(timer)
  }, [search])

  const status = useQuery(statusQuery)
  const authAbsent =
    status.data?.sections.find((section) => section.id === 'auth')?.state === 'absent'
  const offersUsers = modes.includes('user')
  const first = useQuery({
    ...identityUsersQuery(project, ''),
    enabled: open && offersUsers && !authAbsent && project !== '',
  })
  const searched = useQuery({
    ...identityUsersQuery(project, debounced),
    enabled: open && offersUsers && !authAbsent && project !== '' && debounced !== '',
  })
  // The engine answers 404 for the identities route when it runs no
  // Authentication (an older status, or one not loaded yet).
  const routeAbsent = first.error instanceof ApiError && first.error.code === 'not-found'
  const noAuth = authAbsent || routeAbsent
  const searchable = search !== '' || (first.data?.length ?? 0) > SEARCH_AFTER
  const results = debounced === '' ? first : searched
  const users = results.data ?? (debounced !== '' ? undefined : first.data)
  const shown = users?.slice(0, debounced === '' ? SEARCH_AFTER : IDENTITY_PAGE)

  const token = useQuery({
    ...userTokenQuery(value.kind === 'user' ? value : { kind: 'user', uid: '' }, project),
    enabled: value.kind === 'user' && project !== '',
  })
  const synthetic = value.kind === 'user' && token.data?.synthetic === true

  const pick = (next: ViewAs) => {
    onChange(next)
    setOpen(false)
  }

  const { long, short } = labels(value, ownerLabel)
  const quiet = value.kind === modes[0] && (value.kind === 'owner' || value.kind === 'anonymous')
  const current =
    value.kind === 'user' && !(shown ?? []).some((user) => sameUser(value, user))
      ? value
      : undefined

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setSearch('')
        }}
      >
        <DropdownMenu.Trigger
          render={
            <Button
              variant={quiet ? 'ghost' : 'secondary'}
              size="sm"
              icon={iconOf(value.kind)}
              aria-label={`As ${long}`}
              data-testid={testId}
              data-kind={value.kind}
            >
              <span className="flex items-center gap-1">
                <span className="text-kumo-subtle">As</span>
                {/* The qualifier is a reminder, and it is the first line of the
                    menu; the path beside this is read every minute. It yields first. */}
                <span className="hidden 2xl:inline">{long}</span>
                <span className="2xl:hidden">{short}</span>
                {synthetic && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-kumo-warning"
                    aria-label={SYNTHETIC_NOTE}
                  />
                )}
                <CaretDownIcon size={12} className="text-kumo-subtle" />
              </span>
            </Button>
          }
        />
        <DropdownMenu.Content
          className="w-80 max-w-[calc(100vw-2rem)]"
          data-testid={`${testId}-menu`}
        >
          {modes.includes('owner') && (
            <DropdownMenu.Item icon={ShieldCheckIcon} onClick={() => pick({ kind: 'owner' })}>
              {ownerLabel}
              <MenuCheck on={value.kind === 'owner'} />
            </DropdownMenu.Item>
          )}
          {modes.includes('anonymous') && (
            <DropdownMenu.Item
              icon={UserCircleDashedIcon}
              onClick={() => pick({ kind: 'anonymous' })}
            >
              Anonymous client
              <MenuCheck on={value.kind === 'anonymous'} />
            </DropdownMenu.Item>
          )}
          {offersUsers && (
            <>
              {(modes.includes('owner') || modes.includes('anonymous')) && (
                <DropdownMenu.Separator />
              )}
              <DropdownMenu.Group>
                <DropdownMenu.Label>Auth users</DropdownMenu.Label>
                {synthetic && (
                  <div
                    className="px-2 pb-1.5 text-[12px] text-kumo-warning"
                    data-testid={`${testId}-synthetic`}
                  >
                    {SYNTHETIC_NOTE}. The engine has no account{' '}
                    {value.kind === 'user' ? value.uid : ''}, so the requests carry a token made
                    here.
                  </div>
                )}
                {!noAuth && searchable && (
                  <div className="px-1.5 pb-1">
                    <Input
                      size="sm"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      onKeyDown={(event) => {
                        // Letters are the field's, not the menu's typeahead; the
                        // arrows and Escape still move through and close the menu.
                        if (!['ArrowDown', 'ArrowUp', 'Escape', 'Tab'].includes(event.key))
                          event.stopPropagation()
                        if (event.key === 'Enter') {
                          const top = shown?.[0]
                          if (top) pick(viewAsOfUser(top))
                        }
                      }}
                      placeholder="Search by email, uid or name"
                      aria-label="Search Auth users"
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full font-mono"
                      data-testid={`${testId}-search`}
                    />
                  </div>
                )}
                {current && (
                  <DropdownMenu.Item
                    icon={UserIcon}
                    className="items-start"
                    onClick={() => pick(current)}
                  >
                    <UserLines
                      name={current.email ?? current.uid}
                      uid={current.uid}
                      tenant={current.tenant}
                    />
                    <MenuCheck on />
                  </DropdownMenu.Item>
                )}
                {noAuth ? (
                  <DropdownMenu.Item disabled className="items-start">
                    <span
                      className="text-[12px] leading-snug whitespace-normal"
                      data-testid={`${testId}-no-auth`}
                    >
                      Authentication is not running, so there are no users to pick; a custom
                      identity still works.
                    </span>
                  </DropdownMenu.Item>
                ) : results.isError ? (
                  <DropdownMenu.Item disabled className="items-start">
                    <span
                      className="text-[12px] leading-snug whitespace-normal text-kumo-danger"
                      data-testid={`${testId}-error`}
                    >
                      The users could not be listed: {results.error.message}
                    </span>
                  </DropdownMenu.Item>
                ) : shown === undefined ? (
                  <DropdownMenu.Item disabled>
                    <span className="text-[12px]">Looking up users…</span>
                  </DropdownMenu.Item>
                ) : shown.length === 0 ? (
                  <DropdownMenu.Item disabled className="items-start">
                    <span className="text-[12px] leading-snug whitespace-normal">
                      {debounced === ''
                        ? 'No Auth users yet; sign one up from your app.'
                        : `No user matches “${debounced}”.`}
                    </span>
                  </DropdownMenu.Item>
                ) : (
                  shown.map((user) => (
                    <DropdownMenu.Item
                      key={`${user.tenant ?? ''}|${user.uid}`}
                      icon={UserIcon}
                      className="items-start"
                      onClick={() => pick(viewAsOfUser(user))}
                      data-testid={`${testId}-user`}
                    >
                      <UserLines
                        name={userName(user)}
                        uid={user.uid}
                        tenant={user.tenant ?? undefined}
                        disabled={user.disabled}
                      />
                      <MenuCheck on={sameUser(value, user)} />
                    </DropdownMenu.Item>
                  ))
                )}
                {!noAuth && users !== undefined && users.length > (shown?.length ?? 0) && (
                  <div className="px-2 pt-0.5 pb-1 text-[12px] text-kumo-subtle">
                    {debounced === ''
                      ? 'More users: search to find one.'
                      : 'More match: type more to narrow.'}
                  </div>
                )}
              </DropdownMenu.Group>
            </>
          )}
          {modes.includes('custom') && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={IdentificationBadgeIcon}
                className="items-start"
                onClick={() => {
                  setOpen(false)
                  setCustomSession((session) => session + 1)
                  setCustomOpen(true)
                }}
                data-testid={`${testId}-custom`}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>Custom identity…</span>
                  <span className="truncate text-[12px] text-kumo-subtle">
                    {value.kind === 'custom'
                      ? `${value.uid}, ${Object.keys(value.claims).length} claims`
                      : 'Any uid and claims, no Auth record needed'}
                  </span>
                </span>
                <MenuCheck on={value.kind === 'custom'} />
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu>
      {modes.includes('custom') && (
        <Dialog.Root open={customOpen} onOpenChange={setCustomOpen}>
          <Dialog size="lg" className="p-6">
            {/* Kumo's Dialog drops a test id; the contents carry it. */}
            <div className="contents" data-testid={`${testId}-custom-dialog`}>
              <CustomIdentityForm
                key={customSession}
                initial={value.kind === 'custom' || value.kind === 'user' ? value : undefined}
                onCancel={() => setCustomOpen(false)}
                onUse={(custom) => {
                  onChange(custom)
                  setCustomOpen(false)
                }}
                testId={`${testId}-custom-dialog`}
              />
            </div>
          </Dialog>
        </Dialog.Root>
      )}
    </>
  )
}

function UserLines({
  name,
  uid,
  tenant,
  disabled = false,
}: {
  name: string
  uid: string
  tenant: string | undefined
  disabled?: boolean
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate">
        {name}
        {disabled && <span className="text-kumo-subtle"> · disabled</span>}
      </span>
      <span className="truncate font-mono text-[12px] text-kumo-subtle">
        {uid}
        {tenant ? ` · ${tenant}` : ''}
      </span>
    </span>
  )
}

const PROVIDERS = [
  'password',
  'google.com',
  'apple.com',
  'github.com',
  'phone',
  'anonymous',
  'custom',
]

/** The claims text as an object, or what is wrong with it. */
export function parseClaims(text: string): { claims: Record<string, unknown> } | { error: string } {
  if (text.trim() === '') return { claims: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: `The claims are not JSON: ${(error as Error).message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { error: 'Claims are a JSON object, such as {"admin": true}.' }
  return { claims: parsed as Record<string, unknown> }
}

function providerOf(initial: Extract<ViewAs, { kind: 'custom' | 'user' }> | undefined): string {
  if (initial?.kind === 'custom')
    return initial.signInProvider ?? (initial.email ? 'password' : 'custom')
  return initial?.email ? 'password' : 'custom'
}

function CustomIdentityForm({
  initial,
  onCancel,
  onUse,
  testId,
}: {
  /** A custom identity to edit, or a user to start a variation from. */
  initial: Extract<ViewAs, { kind: 'custom' | 'user' }> | undefined
  onCancel: () => void
  onUse: (custom: Extract<ViewAs, { kind: 'custom' }>) => void
  testId: string
}) {
  const [uid, setUid] = useState(initial?.uid ?? '')
  const [email, setEmail] = useState(initial?.email ?? '')
  const [provider, setProvider] = useState(() => providerOf(initial))
  const [verified, setVerified] = useState(
    initial?.kind === 'custom' ? (initial.emailVerified ?? false) : Boolean(initial?.email),
  )
  const [claims, setClaims] = useState(() => JSON.stringify(initial?.claims ?? {}, null, 2))
  // The field says what is wrong with text that is not JSON, under itself,
  // with the line and column; the form adds only what the field cannot know.
  const [read, setRead] = useState<JsonParse | undefined>(undefined)

  const parsed = parseClaims(claims)
  const notJson = read !== undefined && !read.ok
  const problem =
    uid.trim() === '' ? 'Give the identity a uid.' : 'error' in parsed ? parsed.error : undefined
  const use = () => {
    if (problem || !('claims' in parsed)) return
    const custom: Extract<ViewAs, { kind: 'custom' }> = {
      kind: 'custom',
      uid: uid.trim(),
      claims: parsed.claims,
      signInProvider: provider,
      emailVerified: verified,
    }
    if (email.trim()) custom.email = email.trim()
    onUse(custom)
  }

  return (
    <>
      <div className="mb-3 flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">Custom identity</Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <Dialog.Description className="text-kumo-subtle">
        Requests carry an unsigned token with this uid and these claims, which the emulator accepts
        as it would a signed one. No Auth record is needed, and Authentication need not be running.
      </Dialog.Description>
      <form
        className="mt-4 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          use()
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="uid">
            <Input
              size="sm"
              value={uid}
              onChange={(event) => setUid(event.target.value)}
              placeholder="u_tester"
              aria-label="uid"
              spellCheck={false}
              autoComplete="off"
              className="w-full font-mono"
              data-testid={`${testId}-uid`}
            />
          </Field>
          <Field label="Email (optional)">
            <Input
              size="sm"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="tester@example.test"
              aria-label="Email"
              spellCheck={false}
              autoComplete="off"
              className="w-full font-mono"
              data-testid={`${testId}-email`}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 items-end gap-3">
          <Field label="Sign-in provider">
            <Select
              size="sm"
              value={provider}
              onValueChange={(next) => setProvider(String(next))}
              items={Object.fromEntries(PROVIDERS.map((item) => [item, item]))}
              renderValue={(current) => (
                <span className="font-mono text-[12px]">{String(current)}</span>
              )}
              aria-label="Sign-in provider"
              className="w-full min-w-0"
            />
          </Field>
          <div className="pb-1">
            <Checkbox
              checked={verified}
              onCheckedChange={(checked) => setVerified(Boolean(checked))}
              label="Email verified"
            />
          </div>
        </div>
        <Field label="Claims">
          <JsonField
            value={claims}
            onChange={setClaims}
            onParsed={setRead}
            minLines={4}
            maxLines={10}
            ariaLabel="Claims"
            testId={`${testId}-claims`}
          />
        </Field>
        {problem && uid.trim() !== '' && !notJson && (
          <Text size="sm" variant="error">
            {problem}
          </Text>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={problem !== undefined}
            data-testid={`${testId}-use`}
          >
            Use this identity
          </Button>
        </div>
      </form>
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Text as="span" size="xs" variant="secondary">
        {label}
      </Text>
      {children}
    </div>
  )
}
