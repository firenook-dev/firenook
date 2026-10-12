// What the Activity page says about a call and does with it: who called (the
// caller chip), what it caused (steps, as chips in the row and sentences in
// the detail), the request as curl against the Auth emulator itself, the
// replay through the console's mount, and the token a request carried, to
// inspect. Pure: the components render these and the tests hold them.

import type { AuthActivityDetail } from '@/api/generated/auth/AuthActivityDetail'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import type { AuthStep } from '@/api/generated/auth/AuthStep'
import type { EmulatorRequest } from './api'
import { MESSAGE_KIND_LABELS } from './fields'

// ------------------------------------------------------------------ who called

/** The quiet chip a row starts with: who made the call. */
export function callerChip(call: Pick<AuthActivitySummary, 'caller' | 'origin'>): string {
  switch (call.caller) {
    case 'client':
      return 'App'
    case 'admin':
      return 'Admin'
    case 'actionLink':
      return 'Link'
    case 'accountPicker':
      return 'Picker'
    case 'emulatorApi':
      return 'Emulator'
    case 'console':
      return call.origin === 'try' ? 'Try' : call.origin === 'replay' ? 'Replay' : 'Console'
  }
}

/** The credential a call carried, in words. */
export function credentialText(credential: AuthActivitySummary['credential']): string {
  switch (credential) {
    case 'apiKey':
      return 'API key'
    case 'owner':
      return 'owner credential'
    case 'serviceAccount':
      return 'service account token'
    case 'none':
      return 'no credential'
  }
}

/** "3 ms", "41 ms", "0.2 ms", "1.2 s": a call's latency at the precision it deserves. */
export function latencyText(micros: number): string {
  if (micros < 1_000) return `${(micros / 1_000).toFixed(1)} ms`
  if (micros < 10_000_000) {
    const ms = micros / 1_000
    return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`
  }
  return `${Math.round(micros / 1_000_000)} s`
}

// ------------------------------------------------------------------ what it caused

/** One chip of a row's trail. */
export interface StepChip {
  text: string
  tone?: 'danger' | undefined
}

/**
 * What a call caused, as the row's chips: a blocking function with its
 * latency (red when it refused or failed), the triggers it queued, a code
 * sent or used, configuration. Account changes are the row's own subject
 * and are left to the detail.
 */
export function stepChips(steps: readonly AuthStep[], more = 0): StepChip[] {
  const chips: StepChip[] = []
  for (const step of steps) {
    switch (step.kind) {
      case 'blocking':
        chips.push({
          text: `${step.event} ${latencyText(step.durationMicros)}`,
          tone: step.failure ? 'danger' : undefined,
        })
        break
      case 'trigger':
        chips.push({
          text: step.event,
          tone: step.outcome.startsWith('failed') ? 'danger' : undefined,
        })
        break
      case 'message':
        chips.push({ text: 'message' })
        break
      case 'messageUsed':
        chips.push({ text: 'message used' })
        break
      case 'config':
        chips.push({ text: 'config' })
        break
      case 'usersCleared':
        chips.push({ text: 'users cleared' })
        break
      case 'user': {
        const claims = step.fields.includes('customAttributes')
        if (claims) chips.push({ text: 'claims' })
        break
      }
    }
  }
  if (more > 0) chips.push({ text: `+${more} more` })
  return chips
}

/** A trigger step's outcome in words. */
export function triggerOutcomeText(outcome: string): string {
  if (outcome === 'queued') return 'queued for your functions'
  if (outcome === 'deliveryOff') return 'dropped: background triggers were paused'
  if (outcome.startsWith('failed')) return outcome.replace(/^failed:?\s*/, 'not queued: ')
  return outcome
}

/** A user step in words: "Created", "Changed displayName, customAttributes", "Deleted". */
export function userChangeText(step: Extract<AuthStep, { kind: 'user' }>): string {
  if (step.change === 'created') return 'Created'
  if (step.change === 'deleted') return 'Deleted'
  return step.fields.length > 0 ? `Changed ${step.fields.join(', ')}` : 'Changed'
}

/** A configuration step in words. */
export function configText(step: Extract<AuthStep, { kind: 'config' }>): string {
  switch (step.what) {
    case 'project':
      return step.tenant
        ? `Changed the settings of tenant ${step.tenant}`
        : 'Changed the project’s settings'
    case 'tenantCreated':
      return `Created tenant ${step.tenant ?? ''}`.trim()
    case 'tenantUpdated':
      return `Changed tenant ${step.tenant ?? ''}`.trim()
    case 'tenantDeleted':
      return `Deleted tenant ${step.tenant ?? ''}`.trim()
  }
}

/** A message step in words: "Sent Password reset to ada@…". */
export function messageStepText(step: Extract<AuthStep, { kind: 'message' }>): string {
  return `${MESSAGE_KIND_LABELS[step.message]} to ${step.to}`
}

// ------------------------------------------------------------------ bodies

/** Request and response fields that are secrets: shown masked, revealed on request. */
export const MASKED_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'newPassword',
  'oldPassword',
])

/** Whether a body's path leads to a masked field. */
export function isMaskedPath(path: readonly (string | number)[]): boolean {
  const last = path.at(-1)
  return typeof last === 'string' && MASKED_FIELDS.has(last)
}

/** A kept body as JSON, or its text when it is not JSON (an action page answers HTML). */
export function parseBody(text: string | null): { json: unknown } | { text: string } | undefined {
  if (text === null || text === '') return undefined
  try {
    return { json: JSON.parse(text) as unknown }
  } catch {
    return { text }
  }
}

/** The token a request carried, for "Inspect this token": an ID token, else a refresh token. */
export function tokenOfRequest(detail: Pick<AuthActivityDetail, 'request'>): string | undefined {
  const body = parseBody(detail.request)
  if (!body || !('json' in body) || typeof body.json !== 'object' || body.json === null)
    return undefined
  const record = body.json as Record<string, unknown>
  for (const key of ['idToken', 'refresh_token', 'refreshToken', 'token'])
    if (typeof record[key] === 'string' && record[key] !== '') return record[key]
  return undefined
}

/** Shift+C: the call as JSON. */
export function callJson(call: AuthActivitySummary): string {
  return JSON.stringify(call, null, 2)
}

// ------------------------------------------------------------------ curl and replay

/** The headers a replay or a curl sends again: what the SDK said about itself. */
const RESENT_HEADERS = ['x-client-version', 'x-firebase-client', 'x-goog-api-client'] as const

function resent(detail: Pick<AuthActivityDetail, 'headers'>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const header of detail.headers)
    if ((RESENT_HEADERS as readonly string[]).includes(header.name.toLowerCase()))
      headers[header.name.toLowerCase()] = header.value
  return headers
}

/** A shell word in single quotes. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/**
 * The call as curl against the Auth emulator's own address (`authBase`,
 * `http://127.0.0.1:9099`): the method, path and query as recorded, the
 * owner credential when the call used it, the SDK's own headers, the body as
 * received.
 */
export function curlCommand(
  detail: Pick<AuthActivityDetail, 'summary' | 'request' | 'query' | 'headers'>,
  authBase: string,
): string {
  const search = new URLSearchParams()
  for (const pair of detail.query) search.append(pair.name, pair.value)
  const url = `${authBase}${detail.summary.path}${search.size > 0 ? `?${search}` : ''}`
  const parts = [`curl -X ${detail.summary.method} ${quote(url)}`]
  if (detail.summary.credential === 'owner' || detail.summary.credential === 'serviceAccount')
    parts.push(`-H ${quote('authorization: Bearer owner')}`)
  for (const [name, value] of Object.entries(resent(detail)))
    parts.push(`-H ${quote(`${name}: ${value}`)}`)
  if (detail.request !== null && detail.request !== '') {
    parts.push(`-H ${quote('content-type: application/json')}`)
    parts.push(`--data-raw ${quote(detail.request)}`)
  }
  return parts.join(' \\\n  ')
}

/** Why a call cannot be sent again from the console, or nothing when it can. */
export function replayBlocked(
  detail: Pick<AuthActivityDetail, 'replayable' | 'bodiesDropped' | 'summary'>,
  bodiesRetained: boolean | undefined,
): string | undefined {
  if (detail.replayable) return undefined
  if (bodiesRetained === false)
    return 'Request bodies are not kept: the engine runs with --no-diagnostics.'
  if (detail.bodiesDropped) return 'Its request body was dropped for newer calls.'
  if (detail.summary.operation.startsWith('firenook.console.'))
    return 'The console’s own operations are made again from where they started.'
  if (detail.summary.operation === 'emulator.accountPicker')
    return 'The account picker is a page in a browser, not a request to send again.'
  return 'This call cannot be sent again: its request was not kept whole.'
}

/**
 * The replay: the recorded method, path, query and body through the
 * console's mount, with the recorded credential (the owner header, or the
 * API key already in the query) and the SDK's own headers, as a `replay`.
 */
export function replayRequest(
  detail: Pick<AuthActivityDetail, 'summary' | 'request' | 'query' | 'headers'>,
): EmulatorRequest {
  const query: Record<string, string> = {}
  for (const pair of detail.query) query[pair.name] = pair.value
  const credential = detail.summary.credential
  const request: EmulatorRequest = {
    method: detail.summary.method as EmulatorRequest['method'],
    path: detail.summary.path,
    query,
    as: credential === 'owner' || credential === 'serviceAccount' ? 'admin' : 'none',
    origin: 'replay',
    headers: resent(detail),
  }
  const body = detail.request
  if (body !== null && body !== '') {
    try {
      request.body = JSON.parse(body) as unknown
    } catch {
      // A body that is not JSON cannot go through the console as JSON.
    }
  }
  return request
}
