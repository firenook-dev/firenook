// What names a user in a row, a title or a toast: the email, else the phone,
// else the display name — the first thing a developer would recognise — and
// for an account with none of them, words that say so.

import type { AuthUserRow } from '@/api/generated/auth/AuthUserRow'

export interface Identifier {
  text: string
  /** Data (an email, a phone, a name) is set in the data face; the fallbacks are English. */
  data: boolean
}

export function identifierOf(
  row: Pick<AuthUserRow, 'email' | 'phoneNumber' | 'displayName' | 'anonymous'>,
): Identifier {
  if (row.email) return { text: row.email, data: true }
  if (row.phoneNumber) return { text: row.phoneNumber, data: true }
  if (row.displayName) return { text: row.displayName, data: true }
  if (row.anonymous) return { text: 'Anonymous user', data: false }
  return { text: 'No identifier', data: false }
}
