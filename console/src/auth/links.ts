// Where Authentication's things open, and how Auth links into the rest of
// the console. Auth never writes another section's address by hand: a
// user, a call or a message is an `EntityRef` the registry routes; Logs is
// `linkToLogs`; Firestore "as this user" is `serializeViewAs`; a rules line
// is the rules pages' own search schema. And an email link the emulator
// generated opens through the console's own origin, never the Auth port.

import type { EntityRef } from '@/api/generated/EntityRef'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import { API_BASE } from '@/api/client'
import { type ViewAs, serializeViewAs } from '@/lib/identity'
import { auth } from '@/lib/sections/auth'
import { linkToLogs } from '@/lib/sections/logs'
import type { SectionLink } from '@/lib/services'
import { userKey } from './tenant-scope'

// ------------------------------------------------------------------ Auth's own entities

/** A user, as any section's payload names one. */
export function userRef(tenant: string | null | undefined, uid: string, label?: string): EntityRef {
  const ref: EntityRef = { kind: 'auth.user', key: userKey(tenant, uid) }
  if (label !== undefined && label !== uid) ref.label = label
  return ref
}

/** A call to the Auth emulator (its Activity entry), by id. */
export function callRef(id: number, label?: string): EntityRef {
  return label === undefined
    ? { kind: 'auth.call', key: String(id) }
    : { kind: 'auth.call', key: String(id), label }
}

/** A code or link in the Inbox, by id. */
export function messageRef(id: number, label?: string): EntityRef {
  return label === undefined
    ? { kind: 'auth.message', key: String(id) }
    : { kind: 'auth.message', key: String(id), label }
}

function route(ref: EntityRef): SectionLink {
  const open = auth.routes?.[ref.kind]
  if (!open) throw new Error(`Authentication has no route for ${ref.kind}`)
  return open(ref.key)
}

/** The Users page with this user open, through the registry (as every `EntityLink` opens it). */
export function userLink(tenant: string | null | undefined, uid: string): SectionLink {
  return route(userRef(tenant, uid))
}

/** The Activity page with this call open. */
export function callLink(id: number): SectionLink {
  return route(callRef(id))
}

/** The Inbox with this message open. */
export function messageLink(id: number): SectionLink {
  return route(messageRef(id))
}

/** Activity filtered: "Recent calls ↗" (`has:blocking`), a user's calls (`uid:…`). */
export function activityLink(options: {
  q?: string | undefined
  tenant?: string | undefined
}): SectionLink {
  const search: Record<string, string> = {}
  if (options.q) search.q = options.q
  if (options.tenant) search.tenant = options.tenant
  return Object.keys(search).length > 0
    ? { to: '/auth/activity', search }
    : { to: '/auth/activity' }
}

// ------------------------------------------------------------------ as this user, elsewhere

/** An Auth account as the identity requests elsewhere run as (`?as=`). */
export function viewAsUser(user: {
  uid: string
  tenant?: string | null | undefined
  email?: string | null | undefined
}): Extract<ViewAs, { kind: 'user' }> {
  const viewAs: Extract<ViewAs, { kind: 'user' }> = { kind: 'user', uid: user.uid }
  if (user.tenant) viewAs.tenant = user.tenant
  if (user.email) viewAs.email = user.email
  return viewAs
}

/** "Open Firestore as this user": the data page reading through the rules as them. */
export function firestoreAsUser(user: Parameters<typeof viewAsUser>[0]): SectionLink {
  return { to: '/firestore', search: { as: serializeViewAs(viewAsUser(user)) } }
}

/** "Open the rules playground as this user". */
export function playgroundAsUser(user: Parameters<typeof viewAsUser>[0]): SectionLink {
  return {
    to: '/firestore/rules',
    search: { panel: 'playground', as: serializeViewAs(viewAsUser(user)) },
  }
}

// ------------------------------------------------------------------ rules pages

/** Firestore's `db` param: absent for the default database, as its pages write it. */
function dbParam(database: string): string | undefined {
  return database === '' || database === '(default)' ? undefined : database
}

/** Which rules a claim read was found in. */
export type RulesTarget =
  | { service: 'firestore'; database: string }
  | { service: 'storage'; bucket: string }

/**
 * "Read by your rules · line 12 ↗": the rules page of that database or
 * bucket at that line, in the rules pages' shared search schema (`db` or
 * `bucket`, and `line`, which the page reveals once).
 */
export function rulesLineLink(target: RulesTarget, line: number): SectionLink {
  if (target.service === 'firestore')
    return { to: '/firestore/rules', search: { db: dbParam(target.database), line } }
  return { to: '/storage/rules', search: { bucket: target.bucket, line } }
}

/** "Rules decisions for this user ↗": the Firestore rules page's decisions, narrowed to the uid. */
export function rulesDecisionsLink(uid: string, database = '(default)'): SectionLink {
  return { to: '/firestore/rules', search: { db: dbParam(database), panel: 'decisions', uid } }
}

// ------------------------------------------------------------------ Logs

/** How far around a call its Auth lines are looked for, ms. */
const AROUND_MS = 2_000

/**
 * "Open in Logs" for a call: the lines of the blocking function it ran, by
 * invocation, or else the Auth lines around its time.
 */
export function logsForCall(
  call: Pick<AuthActivitySummary, 'at' | 'durationMicros' | 'steps'>,
): SectionLink {
  for (const step of call.steps)
    if (step.kind === 'blocking' && step.invocation)
      return linkToLogs({ execution: step.invocation })
  const at = Date.parse(call.at)
  if (Number.isNaN(at)) return linkToLogs({ service: 'auth' })
  const end = at + Math.ceil(call.durationMicros / 1_000)
  return linkToLogs({
    service: 'auth',
    from: new Date(at - AROUND_MS).toISOString(),
    to: new Date(end + AROUND_MS).toISOString(),
  })
}

// ------------------------------------------------------------------ email links

/** Where the Auth emulator's action page answers on the console's own origin. */
export const ACTION_PATH = `${API_BASE}/auth/emulator/action`

/**
 * An email link as the console opens it: the emulator wrote it on the Auth
 * port, which a browser behind a proxy (or another machine) may not reach,
 * so the query is kept and the origin and path become the console mount's
 * action page — which does exactly what the link does. Copy the link as
 * generated for a device or simulator instead.
 */
export function consoleActionLink(link: string, origin: string = location.origin): string {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return link
  }
  return `${origin}${ACTION_PATH}${url.search}`
}
