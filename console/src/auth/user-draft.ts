// The inspector's edit of one account, field by field. A draft holds, for
// each field the developer touched, the value it started from and the value
// they typed; nothing else. That is what lets an app keep signing the user
// in while their display name is being edited: a sign-in moves
// `lastLoginAt` and `lastRefreshAt`, which the draft does not hold, so it
// conflicts with nothing. A real collision — someone else changed the very
// field being edited — is a conflict for that field alone (`draftConflicts`),
// answered with Use theirs or Keep mine.
//
// Save writes the draft in one `accounts:update`, as the Admin SDK's
// `updateUser` and `setCustomUserClaims` would.

import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'
import { readClaims } from './claims'

export interface UserValues {
  displayName: string
  photoUrl: string
  email: string
  emailVerified: boolean
  phoneNumber: string
  disabled: boolean
  /** ISO instants, as the timestamp fields edit them; `''` for none. */
  createdAt: string
  lastLoginAt: string
  /** The claims text as the editor holds it; compared by its compact JSON. */
  claims: string
}

export type DraftField = keyof UserValues

export const FIELD_LABELS: Readonly<Record<DraftField, string>> = {
  displayName: 'Display name',
  photoUrl: 'Photo URL',
  email: 'Email',
  emailVerified: 'Verified email',
  phoneNumber: 'Phone',
  disabled: 'Disabled',
  createdAt: 'Created',
  lastLoginAt: 'Last sign-in',
  claims: 'Custom claims',
}

/** One touched field: what it was when editing began, and what is typed now. */
export type DraftEntry<F extends DraftField = DraftField> = {
  from: UserValues[F]
  to: UserValues[F]
}

export type UserDraft = { [F in DraftField]?: DraftEntry<F> }

function iso(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString()
}

/** The editable values of a stored account. */
export function valuesOf(detail: AuthUserDetail): UserValues {
  const row = detail.row
  return {
    displayName: row.displayName ?? '',
    photoUrl: row.photoUrl ?? '',
    email: row.email ?? '',
    emailVerified: row.emailVerified,
    phoneNumber: row.phoneNumber ?? '',
    disabled: row.disabled,
    createdAt: iso(row.createdAt),
    lastLoginAt: iso(row.lastSignInAt),
    claims:
      detail.claims && Object.keys(detail.claims).length > 0
        ? JSON.stringify(detail.claims, null, 2)
        : '',
  }
}

/** Claims compared by what they say, not how they are indented. */
function canonicalClaims(text: string): string {
  if (text.trim() === '') return '{}'
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return text
  }
}

/** Instants compared by the moment they name (`…00Z` and `…00.000Z` are one). */
function canonicalTime(text: string): string {
  if (text.trim() === '') return ''
  const at = Date.parse(text)
  return Number.isNaN(at) ? text : String(at)
}

/** Whether two values of a field say the same thing. */
export function sameValue<F extends DraftField>(
  field: F,
  a: UserValues[F],
  b: UserValues[F],
): boolean {
  if (field === 'claims') return canonicalClaims(a as string) === canonicalClaims(b as string)
  if (field === 'createdAt' || field === 'lastLoginAt')
    return canonicalTime(a as string) === canonicalTime(b as string)
  return a === b
}

/** The draft with one field typed; a field touched first starts from the server's value. */
export function editDraft<F extends DraftField>(
  draft: UserDraft,
  server: UserValues,
  field: F,
  value: UserValues[F],
): UserDraft {
  const from = (draft[field]?.from ?? server[field]) as UserValues[F]
  return { ...draft, [field]: { from, to: value } }
}

/** What the field shows: the typed value while touched, else the server's. */
export function shownValue<F extends DraftField>(
  draft: UserDraft,
  server: UserValues,
  field: F,
): UserValues[F] {
  const entry = draft[field] as DraftEntry<F> | undefined
  return entry ? entry.to : server[field]
}

/** The fields Save would write: touched, and different from the server's value now. */
export function changedFields(draft: UserDraft, server: UserValues): DraftField[] {
  return (Object.keys(draft) as DraftField[]).filter((field) => {
    const entry = draft[field] as DraftEntry | undefined
    return entry !== undefined && !sameValue(field, entry.to, server[field])
  })
}

/** One field someone else changed while it was being edited. */
export interface DraftConflict {
  field: DraftField
  /** What the draft holds. */
  mine: UserValues[DraftField]
  /** What the server holds now. */
  theirs: UserValues[DraftField]
}

/**
 * For each field in the draft only, whether the server's value moved away
 * from the one the draft started from (and from the one typed). Fields not
 * in the draft are never a conflict: they update in place.
 */
export function draftConflicts(
  base: Partial<UserValues>,
  server: UserValues,
  draft: UserDraft,
): DraftConflict[] {
  const conflicts: DraftConflict[] = []
  for (const field of Object.keys(draft) as DraftField[]) {
    const entry = draft[field] as DraftEntry | undefined
    const from = base[field]
    if (!entry || from === undefined) continue
    if (sameValue(field, from, server[field])) continue
    if (sameValue(field, entry.to, server[field])) continue
    conflicts.push({ field, mine: entry.to, theirs: server[field] })
  }
  return conflicts
}

/** The values each touched field started from: what `draftConflicts` compares the server with. */
export function draftBase(draft: UserDraft): Partial<UserValues> {
  const base: Partial<Record<DraftField, unknown>> = {}
  for (const field of Object.keys(draft) as DraftField[]) base[field] = draft[field]?.from
  return base as Partial<UserValues>
}

/** Use theirs: the field leaves the draft and shows the server's value. */
export function takeTheirs(draft: UserDraft, field: DraftField): UserDraft {
  const { [field]: _gone, ...rest } = draft
  return rest
}

/** Keep mine: the draft now starts from the server's value, so the conflict is answered. */
export function keepMine(draft: UserDraft, server: UserValues, field: DraftField): UserDraft {
  const entry = draft[field]
  if (!entry) return draft
  return { ...draft, [field]: { ...entry, from: server[field] } }
}

const EMAIL = /^[^@\s]+@[^@\s]+$/

/** What is wrong with the typed values, by field: Save waits until there is nothing. */
export function draftProblems(draft: UserDraft): Partial<Record<DraftField, string>> {
  const problems: Partial<Record<DraftField, string>> = {}
  const email = draft.email?.to.trim()
  if (email && !EMAIL.test(email))
    problems.email = 'An email address has one @ with text on both sides.'
  const phone = draft.phoneNumber?.to.trim()
  if (phone && !/^\+[1-9]\d{1,14}$/.test(phone.replace(/[\s().-]/g, '')))
    problems.phoneNumber =
      'A phone number is + then the country code and number (E.164), like +15550100.'
  for (const field of ['createdAt', 'lastLoginAt'] as const) {
    const text = draft[field]?.to.trim()
    if (text === undefined) continue
    if (text === '' && draft[field]?.from !== '')
      problems[field] = 'The emulator cannot unset this time; set another one.'
    else if (text !== '' && Number.isNaN(Date.parse(text)))
      problems[field] = 'Not a time yet: write it like 2026-10-12T09:14:02Z.'
  }
  if (draft.claims) {
    const reading = readClaims(draft.claims.to)
    if (!reading.ok) problems.claims = reading.message
  }
  return problems
}

/**
 * The `accounts:update` body that writes the changed fields, as the Admin
 * SDK sends it: a cleared name or photo is `deleteAttribute`, a cleared
 * phone is `deleteProvider: ['phone']`, claims are their compact JSON.
 */
export function updateBody(
  uid: string,
  draft: UserDraft,
  server: UserValues,
): Record<string, unknown> {
  const body: Record<string, unknown> = { localId: uid }
  const deleteAttribute: string[] = []
  for (const field of changedFields(draft, server)) {
    const value = draft[field]?.to
    switch (field) {
      case 'displayName':
      case 'photoUrl': {
        const text = (value as string).trim()
        if (text === '')
          deleteAttribute.push(field === 'displayName' ? 'DISPLAY_NAME' : 'PHOTO_URL')
        else body[field] = text
        break
      }
      case 'email': {
        const text = (value as string).trim()
        if (text === '') deleteAttribute.push('EMAIL')
        else body.email = text
        break
      }
      case 'phoneNumber': {
        const text = (value as string).replace(/[\s().-]/g, '')
        if (text === '') body.deleteProvider = ['phone']
        else body.phoneNumber = text
        break
      }
      case 'emailVerified':
        body.emailVerified = value as boolean
        break
      case 'disabled':
        body.disableUser = value as boolean
        break
      case 'createdAt':
      case 'lastLoginAt':
        body[field] = String(Date.parse(value as string))
        break
      case 'claims': {
        const reading = readClaims(value as string)
        if (reading.ok) body.customAttributes = reading.compact
        break
      }
    }
  }
  if (deleteAttribute.length > 0) body.deleteAttribute = deleteAttribute
  return body
}
