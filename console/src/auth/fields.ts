// The Authentication pages' filter fields and facets, in the console's one
// filter grammar (`lib/filter.ts` ⇄ `filter.rs`).
//
// The fields are the engine's `USER_FIELDS`, `ACTIVITY_FIELDS` and
// `MESSAGE_FIELDS` (`crates/console-front/src/auth/filter.rs`) written
// again, held to the same golden case files
// (`filter-cases/{users,activity,inbox}.json`) by both sides, so a filter the
// browser accepts is one the engine accepts. The browser parses only to
// paint tokens, complete and say what is wrong before the engine answers;
// the engine filters, counts and pages.
//
// The facets are quicker ways to type terms: each writes the term its
// filter key spells (`is:disabled`, `-has:sign-in`, `has:email
// -is:verified`), so the URL's `q` stays the truth and a facet's pressed
// state is read back from it. Groups follow the keys — facets in one group
// combine as any of (a repeated key), groups narrow — and a panel shows
// breakdowns only: the toolbar's count says how many match in all.

import type { AuthActivityFacets } from '@/api/generated/auth/AuthActivityFacets'
import type { AuthCallKind } from '@/api/generated/auth/AuthCallKind'
import type { AuthCaller } from '@/api/generated/auth/AuthCaller'
import type { AuthClaimKeys } from '@/api/generated/auth/AuthClaimKeys'
import type { AuthMessageFacets } from '@/api/generated/auth/AuthMessageFacets'
import type { AuthMessageKind } from '@/api/generated/auth/AuthMessageKind'
import type { AuthUserFacets } from '@/api/generated/auth/AuthUserFacets'
import { type Facet, type FacetGroup, facetState } from '@/components/console/facet-list'
import type { FilterFieldSpec } from '@/components/console/filter-field'
import { asciiLower, filterValueText } from '@/lib/filter'

// ------------------------------------------------------------------ fields

/** The users table (`GET /auth/users?q=`). */
export const USER_FIELDS: readonly FilterFieldSpec[] = [
  {
    key: 'is',
    kind: 'enum',
    help: 'Account state',
    values: ['disabled', 'verified', 'anonymous', 'custom-token', 'sample'],
  },
  {
    key: 'has',
    kind: 'enum',
    help: 'What the account has',
    values: ['email', 'phone', 'password', 'mfa', 'claims', 'photo', 'name', 'sign-in'],
  },
  { key: 'provider', aliases: ['p'], kind: 'exact', help: 'Linked sign-in provider' },
  { key: 'claim', kind: 'exact', help: 'Custom claim' },
  { key: 'created', kind: 'time', help: 'When the account was created' },
  { key: 'signed-in', aliases: ['last-sign-in'], kind: 'time', help: 'Last sign-in' },
  { key: 'uid', aliases: ['id'], kind: 'exact', help: 'Account id' },
  { key: 'email', kind: 'text', help: 'Email address' },
  { key: 'phone', kind: 'text', help: 'Phone number' },
  { key: 'name', kind: 'text', help: 'Display name' },
]

/** The Activity list and its topic (`GET /auth/activity?q=`, `auth.activity`). */
export const ACTIVITY_FIELDS: readonly FilterFieldSpec[] = [
  { key: 'is', kind: 'enum', help: 'What the call did', values: ['error', 'new-user'] },
  {
    key: 'kind',
    kind: 'enum',
    help: 'What kind of call',
    values: ['sign-in', 'sign-up', 'refresh', 'code', 'account', 'config', 'lookup', 'other'],
  },
  {
    key: 'caller',
    kind: 'enum',
    help: 'Who called',
    values: ['app', 'admin', 'console', 'link', 'picker', 'emulator'],
  },
  { key: 'op', kind: 'text', help: 'The operation, like signInWithPassword' },
  { key: 'provider', aliases: ['p'], kind: 'exact', help: 'Sign-in provider' },
  { key: 'uid', aliases: ['id'], kind: 'exact', help: 'Account id' },
  {
    key: 'has',
    kind: 'enum',
    help: 'What the call caused',
    values: ['blocking', 'trigger', 'message', 'change', 'config'],
  },
  { key: 'status', kind: 'number', help: 'HTTP status' },
  { key: 'took', kind: 'duration', help: 'How long the call took' },
  { key: 'at', kind: 'time', help: 'When the call was made' },
]

/** The Inbox and its topic (`GET /auth/messages?q=`, `auth.inbox`). */
export const MESSAGE_FIELDS: readonly FilterFieldSpec[] = [
  {
    key: 'is',
    kind: 'enum',
    help: 'What became of the message',
    values: ['used', 'returned', 'restored'],
  },
  { key: 'type', kind: 'enum', help: 'Email or SMS', values: ['email', 'sms'] },
  {
    key: 'kind',
    kind: 'enum',
    help: 'What the message is for',
    values: ['verify', 'reset', 'sign-in', 'change', 'recover', 'sms', 'mfa-enroll', 'mfa-sign-in'],
  },
  { key: 'uid', aliases: ['id'], kind: 'exact', help: 'Account id' },
  { key: 'to', kind: 'text', help: 'Recipient' },
  { key: 'at', kind: 'time', help: 'When it was sent' },
]

/** What the filter fields can complete from the engine's own figures. */
export interface UserSuggestions {
  /** Provider ids users carry (the facets' providers, most first). */
  providers?: () => readonly string[]
  /** Claim keys users carry (`GET /auth/claims`, most users first). */
  claims?: () => AuthClaimKeys | undefined
}

/** Completion values that start with what is typed, case-insensitively, without repeats. */
function startingWith(values: readonly string[], prefix: string, limit = 50): string[] {
  const typed = asciiLower(prefix)
  const seen = new Set<string>()
  const found: string[] = []
  for (const value of values) {
    if (seen.has(value) || !asciiLower(value).startsWith(typed)) continue
    seen.add(value)
    found.push(value)
    if (found.length >= limit) break
  }
  return found
}

/** A claim's sample value as `claim:` writes it: a JSON scalar as itself, a string bare or quoted. */
function claimValueText(sample: unknown): string | undefined {
  if (sample === null || typeof sample === 'boolean' || typeof sample === 'number')
    return JSON.stringify(sample)
  if (typeof sample === 'string') {
    // A string that would read as a scalar (`"true"`, `"3"`) must stay a
    // string: the engine reads `claim:plan=3` as the number.
    try {
      const parsed: unknown = JSON.parse(sample)
      if (parsed === null || typeof parsed !== 'object') return JSON.stringify(sample)
    } catch {
      // Not JSON: plain text, written as it is.
    }
    return sample
  }
  return undefined
}

/**
 * `claim:` completions: each key users carry (`role`), then, once a key and
 * `=` are typed, the values seen for it (`role=admin`), all written so the
 * engine reads them back as they are stored.
 */
export function claimSuggestions(keys: AuthClaimKeys | undefined, prefix: string): string[] {
  if (!keys) return []
  const equals = prefix.indexOf('=')
  if (equals === -1)
    return startingWith(
      keys.keys.map((key) => key.key),
      prefix,
    )
  const name = prefix.slice(0, equals)
  const key = keys.keys.find((candidate) => candidate.key === name)
  if (!key) return []
  const values = key.samples.flatMap((sample) => {
    const text = claimValueText(sample)
    return text === undefined ? [] : [`${name}=${text}`]
  })
  return startingWith(values, prefix)
}

/**
 * The users fields with live completion: provider ids from the facets and
 * claim keys (and their sample values) from `GET /auth/claims`. The
 * callbacks are read on each completion, so new figures never rebuild the
 * fields.
 */
export function userFields(suggestions: UserSuggestions): FilterFieldSpec[] {
  const { providers, claims } = suggestions
  return USER_FIELDS.map((field) => {
    if (field.key === 'provider' && providers)
      return suggesting(field, (prefix) => startingWith(providers(), prefix))
    if (field.key === 'claim' && claims)
      return suggesting(field, (prefix) => claimSuggestions(claims(), prefix))
    return field
  })
}

/** The Activity fields with provider ids to complete from. */
export function activityFields(providers?: () => readonly string[]): FilterFieldSpec[] {
  if (!providers) return [...ACTIVITY_FIELDS]
  return ACTIVITY_FIELDS.map((field) =>
    field.key === 'provider'
      ? suggesting(field, (prefix) => startingWith(providers(), prefix))
      : field,
  )
}

/** A field that completes its values from `suggest` too. */
function suggesting(
  field: FilterFieldSpec,
  suggest: (prefix: string) => readonly string[],
): FilterFieldSpec {
  return { ...field, suggest }
}

// ------------------------------------------------------------------ facets

/** A term with its value written as the grammar reads it back. */
function term(key: string, value: string): string {
  return `${key}:${filterValueText(value)}`
}

/** The users panel: "Account", "Has", "Not yet", "Providers". */
export function userFacetGroups(facets: AuthUserFacets | null | undefined): FacetGroup[] {
  const account: Facet[] = [
    { term: 'is:disabled', label: 'Disabled', count: facets?.disabled },
    { term: 'is:anonymous', label: 'Anonymous', count: facets?.anonymous },
    { term: 'is:custom-token', label: 'Custom token', count: facets?.customToken },
  ]
  // Only when there are some: most projects never add sample users.
  if ((facets?.sample ?? 0) > 0)
    account.push({ term: 'is:sample', label: 'Sample users', count: facets?.sample })
  const groups: FacetGroup[] = [
    { label: 'Account', facets: account },
    {
      label: 'Has',
      facets: [
        { term: 'has:mfa', label: 'MFA', count: facets?.mfa },
        { term: 'has:claims', label: 'Custom claims', count: facets?.claims },
      ],
    },
    {
      // Negations: they always narrow, so they sit apart from the groups
      // whose facets combine as any of.
      label: 'Not yet',
      facets: [
        { term: 'has:email -is:verified', label: 'Unverified email', count: facets?.unverified },
        { term: '-has:sign-in', label: 'Never signed in', count: facets?.neverSignedIn },
      ],
    },
  ]
  const providers = facets?.providers ?? []
  if (providers.length > 0)
    groups.push({
      label: 'Providers',
      facets: providers.map((entry) => ({
        term: term('provider', entry.provider),
        label: entry.provider,
        count: entry.users,
      })),
    })
  return groups
}

/** The filter's spelling of each caller (`caller:app`), the engine's `caller_value`. */
export const CALLER_VALUES: Readonly<Record<AuthCaller, string>> = {
  client: 'app',
  admin: 'admin',
  console: 'console',
  actionLink: 'link',
  accountPicker: 'picker',
  emulatorApi: 'emulator',
}

/** How a caller reads in the panel. */
export const CALLER_LABELS: Readonly<Record<AuthCaller, string>> = {
  client: 'App',
  admin: 'Admin',
  console: 'Console',
  actionLink: 'Action links',
  accountPicker: 'Account picker',
  emulatorApi: 'Emulator API',
}

/** How each kind of call reads in the panel, in the panel's order. */
export const CALL_KIND_LABELS: Readonly<Record<AuthCallKind, string>> = {
  'sign-in': 'Sign-ins',
  'sign-up': 'Sign-ups',
  code: 'Codes & links',
  account: 'Account changes',
  refresh: 'Token refreshes',
  config: 'Configuration',
  lookup: 'Lookups',
  other: 'Other calls',
}

/** Kinds and callers listed whatever their count: the ones a developer reaches for. */
const ALWAYS_KINDS: ReadonlySet<AuthCallKind> = new Set([
  'sign-in',
  'sign-up',
  'code',
  'account',
  'refresh',
  'config',
])
const ALWAYS_CALLERS: ReadonlySet<AuthCaller> = new Set(['client', 'admin', 'actionLink'])

/**
 * The Activity panel: "Outcome", "Kind of call", "Caller". The rarer kinds
 * and callers (lookups, the account picker, the emulator's own API, the
 * console) are listed only while there are some, or while their term is in
 * the filter, so a pressed facet never disappears.
 */
export function activityFacetGroups(
  facets: AuthActivityFacets | null | undefined,
  q = '',
): FacetGroup[] {
  const inFilter = (text: string) => facetState(q, text) !== 'off'
  const kindCounts = new Map(facets?.kinds.map((entry) => [entry.kind, entry.calls]))
  const callerCounts = new Map(facets?.callers.map((entry) => [entry.caller, entry.calls]))
  const kinds = (Object.keys(CALL_KIND_LABELS) as AuthCallKind[]).flatMap((kind): Facet[] => {
    const calls = kindCounts.get(kind)
    const text = term('kind', kind)
    if (!ALWAYS_KINDS.has(kind) && !calls && !inFilter(text)) return []
    return [{ term: text, label: CALL_KIND_LABELS[kind], count: facets ? (calls ?? 0) : undefined }]
  })
  const callers = (Object.keys(CALLER_LABELS) as AuthCaller[]).flatMap((caller): Facet[] => {
    const calls = callerCounts.get(caller)
    const text = term('caller', CALLER_VALUES[caller])
    if (!ALWAYS_CALLERS.has(caller) && !calls && !inFilter(text)) return []
    return [{ term: text, label: CALLER_LABELS[caller], count: facets ? (calls ?? 0) : undefined }]
  })
  return [
    {
      label: 'Outcome',
      facets: [
        { term: 'is:error', label: 'Errors', count: facets?.errors, tone: 'danger' },
        { term: 'is:new-user', label: 'New users', count: facets?.newUsers },
      ],
    },
    { label: 'Kind of call', facets: kinds },
    { label: 'Caller', facets: callers },
  ]
}

/** The filter's spelling of each message kind (`kind:reset`), the engine's `message_kind_value`. */
export const MESSAGE_KIND_VALUES: Readonly<Record<AuthMessageKind, string>> = {
  verifyEmail: 'verify',
  passwordReset: 'reset',
  emailSignIn: 'sign-in',
  verifyAndChangeEmail: 'change',
  recoverEmail: 'recover',
  smsSignIn: 'sms',
  smsMfaEnrollment: 'mfa-enroll',
  smsMfaSignIn: 'mfa-sign-in',
}

/** How each kind of message reads: in the panel, and as a row's label. */
export const MESSAGE_KIND_LABELS: Readonly<Record<AuthMessageKind, string>> = {
  passwordReset: 'Password reset',
  verifyEmail: 'Email verification',
  emailSignIn: 'Sign-in link',
  verifyAndChangeEmail: 'Email change',
  recoverEmail: 'Email recovery',
  smsSignIn: 'SMS sign-in code',
  smsMfaEnrollment: 'MFA enrolment code',
  smsMfaSignIn: 'MFA sign-in code',
}

/** The Inbox panel: "Waiting", "Delivery", "Kind" (the kinds the engine has kept). */
export function messageFacetGroups(
  facets: AuthMessageFacets | null | undefined,
  q = '',
): FacetGroup[] {
  const counts = new Map(facets?.kinds.map((entry) => [entry.kind, entry.messages]))
  const kinds = (Object.keys(MESSAGE_KIND_LABELS) as AuthMessageKind[]).flatMap((kind): Facet[] => {
    const messages = counts.get(kind)
    const text = term('kind', MESSAGE_KIND_VALUES[kind])
    if (!messages && facetState(q, text) === 'off') return []
    return [{ term: text, label: MESSAGE_KIND_LABELS[kind], count: messages ?? 0 }]
  })
  const groups: FacetGroup[] = [
    { label: 'Waiting', facets: [{ term: '-is:used', label: 'Unused', count: facets?.unused }] },
    {
      label: 'Delivery',
      facets: [
        { term: 'is:returned', label: 'Returned', count: facets?.returned },
        { term: 'is:restored', label: 'From saved state', count: facets?.restored },
      ],
    },
  ]
  if (kinds.length > 0) groups.push({ label: 'Kind', facets: kinds })
  return groups
}
