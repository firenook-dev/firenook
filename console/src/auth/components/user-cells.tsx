// The users grid's columns and what each cell draws. A value is data, so it
// is the data face at 12 px; the relative times are the only English in a
// row, so the only sans. One chip in the grid has a colour — `disabled` —
// because it is the one state that changes what the app can do; the rest
// are quiet chips that take a step of ink with the row's hover.

import { InlineCopyText, Tooltip, cn } from '@cloudflare/kumo'
import type { ReactNode } from 'react'
import type { AuthUserRow } from '@/api/generated/auth/AuthUserRow'
import type { DataTableColumn } from '@/components/console/data-table'
import { RelativeTime } from '@/components/console/relative-time'
import { formatNumber } from '@/lib/format'
import { identifierOf } from '../identifier'
import { ProviderGlyphs } from './provider-glyphs'
import { UserAvatar } from './user-avatar'

/** The rule a cell draws for a value the account does not have. */
export function NotSet({ what }: { what: string }) {
  return (
    <span
      className="block h-px w-3 bg-kumo-line"
      role="img"
      aria-label={`no ${what}`}
      data-testid="not-set"
    />
  )
}

/** Avatar and the identifier: email ▸ phone ▸ display name ▸ "Anonymous user" ▸ "No identifier". */
export function UserCell({ row }: { row: AuthUserRow }) {
  const identifier = identifierOf(row)
  return (
    <span className="flex min-w-0 items-center gap-2">
      <UserAvatar
        photoUrl={row.photoUrl}
        name={row.displayName}
        email={row.email}
        anonymous={row.anonymous}
      />
      <span
        className={cn(
          'min-w-0 truncate text-[12px]',
          identifier.data ? 'font-mono text-kumo-default' : 'font-sans text-kumo-subtle',
        )}
        data-testid="user-identifier"
      >
        {identifier.text}
      </span>
    </span>
  )
}

function DataText({ value, what }: { value: string | null; what: string }) {
  if (!value) return <NotSet what={what} />
  return <span className="block truncate font-mono text-[12px]">{value}</span>
}

/** A relative time with the exact instant in its tooltip; `never` when there is none. */
function TimeCell({ ms, never }: { ms: number | null; never?: string }) {
  if (ms === null)
    return never ? (
      <span className="font-sans text-[12px] text-kumo-subtle">{never}</span>
    ) : (
      <NotSet what="time" />
    )
  return <RelativeTime iso={new Date(ms).toISOString()} />
}

/** A quiet 11 px chip that keeps its ground when the row lights up. */
function Chip({ children, tone }: { children: ReactNode; tone?: 'danger' | undefined }) {
  return (
    <span
      className={cn(
        'flex h-4.5 shrink-0 items-center rounded px-1 font-mono text-[11px]',
        tone === 'danger'
          ? 'bg-kumo-danger-tint text-kumo-danger'
          : 'bg-kumo-tint text-kumo-subtle group-hover/row:ink',
      )}
      data-testid="status-chip"
    >
      {children}
    </span>
  )
}

/** The account's states, most consequential first: what the Status column's chips say. */
export function statusWords(
  row: Pick<
    AuthUserRow,
    'disabled' | 'email' | 'emailVerified' | 'mfa' | 'claimKeys' | 'customAuth'
  >,
): { key: string; text: string; tone?: 'danger' }[] {
  const words: { key: string; text: string; tone?: 'danger' }[] = []
  if (row.disabled) words.push({ key: 'disabled', text: 'disabled', tone: 'danger' })
  if (row.email && !row.emailVerified) words.push({ key: 'unverified', text: 'unverified' })
  if (row.mfa > 0) words.push({ key: 'mfa', text: `MFA ${formatNumber(row.mfa)}` })
  if (row.claimKeys.length > 0)
    words.push({ key: 'claims', text: `claims ${formatNumber(row.claimKeys.length)}` })
  if (row.customAuth) words.push({ key: 'custom', text: 'custom' })
  return words
}

/**
 * The account's state in chips: disabled, unverified (only with an email),
 * MFA, claims, custom. A chip is shown whole or not at all: the chips wrap,
 * and the line below the first is clipped, so a column narrowed by a drag
 * drops the last chips instead of cutting a word. With more than one chip,
 * the cell's tooltip lists them all.
 */
export function StatusCell({ row }: { row: AuthUserRow }) {
  const words = statusWords(row)
  if (words.length === 0) return null
  const chips = (
    <span
      className="flex h-4.5 min-w-0 flex-wrap items-center gap-x-1 overflow-hidden"
      aria-label={words.map((word) => word.text).join(', ')}
      data-testid="status-chips"
    >
      {words.map((word) => (
        <Chip key={word.key} tone={word.tone}>
          {word.text}
        </Chip>
      ))}
    </span>
  )
  if (words.length === 1) return chips
  return <Tooltip content={words.map((word) => word.text).join(' · ')} render={chips} />
}

/** The uid, copyable on its own: a click copies and does not open the row. */
function UidCell({ uid }: { uid: string }) {
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- only keeps the copy's click from also opening the row; the copy is its own button
    <span className="inline-flex max-w-full min-w-0" onClick={(event) => event.stopPropagation()}>
      <InlineCopyText
        value={uid}
        variant="body"
        size="xs"
        className="min-w-0 truncate font-mono"
        data-testid="user-uid"
      >
        {uid}
      </InlineCopyText>
    </span>
  )
}

/** The column ids the engine sorts by (`GET /auth/users/meta`), and the User column's. */
export const USER_COLUMN = 'email'

/**
 * The users grid's fixed columns; `sortable` is the meta's list, `pinned` the
 * User column's freeze. Their default widths add up to what a 1440 px window
 * gives the table beside the nav and the panel (876 px between the check
 * cell and the columns menu), so everything up to Status is in view
 * unscrolled. Phone comes after Status: a phone user's number is already
 * the User column's identifier, so the column mostly repeats it or is empty.
 */
export function userColumns(options: {
  sortable: readonly string[]
  pinned: boolean
}): DataTableColumn<AuthUserRow>[] {
  const sorts = (id: string) => options.sortable.includes(id)
  return [
    {
      id: USER_COLUMN,
      header: 'User',
      width: 260,
      minWidth: 140,
      pinned: options.pinned,
      sortable: sorts(USER_COLUMN),
      cell: (row) => <UserCell row={row} />,
      // ⌘C on the key column copies the uid, as on the row itself.
    },
    {
      id: 'name',
      header: 'Name',
      width: 160,
      sortable: sorts('name'),
      cell: (row) => <DataText value={row.displayName} what="name" />,
      copy: (row) => row.displayName ?? '',
    },
    {
      id: 'providers',
      header: 'Providers',
      width: 96,
      cell: (row) => <ProviderGlyphs row={row} />,
      copy: (row) => row.providers.join(', '),
    },
    {
      id: 'created',
      header: 'Created',
      width: 96,
      sortable: sorts('created'),
      cell: (row) => <TimeCell ms={row.createdAt} />,
      copy: (row) => (row.createdAt === null ? '' : new Date(row.createdAt).toISOString()),
    },
    {
      id: 'signedIn',
      header: 'Signed in',
      width: 96,
      sortable: sorts('signedIn'),
      cell: (row) => <TimeCell ms={row.lastSignInAt} never="never" />,
      copy: (row) => (row.lastSignInAt === null ? '' : new Date(row.lastSignInAt).toISOString()),
    },
    {
      id: 'status',
      header: 'Status',
      width: 160,
      minWidth: 96,
      cell: (row) => <StatusCell row={row} />,
    },
    {
      id: 'phone',
      header: 'Phone',
      width: 140,
      sortable: sorts('phone'),
      cell: (row) => <DataText value={row.phoneNumber} what="phone" />,
      copy: (row) => row.phoneNumber ?? '',
    },
    {
      id: 'uid',
      header: 'uid',
      width: 220,
      sortable: sorts('uid'),
      cell: (row) => <UidCell uid={row.uid} />,
    },
  ]
}
