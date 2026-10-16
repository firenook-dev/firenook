import type { ConsoleStatus } from './generated/ConsoleStatus'
import type { ErrorCode } from './generated/ErrorCode'

// The engine serves the Console API next to the app, so every call is
// same-origin and relative to the console's mount path.
export const API_BASE = '/console/api/v1'

/** The header every request the console makes carries (§ request guard). */
const CONSOLE_HEADER = 'x-firenook-console'

/**
 * The engine's code; `network` when no answer arrived; `unknown` for a body
 * neither error shape explains.
 */
export type ApiErrorCode = ErrorCode | 'network' | 'unknown'

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly fix: string | undefined

  constructor(status: number, message: string, code: ApiErrorCode = 'unknown', fix?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fix = fix
  }
}

// Every code the engine sends. A `Record` over the generated union makes the
// compiler fail when a code is added in Rust and not here, or the reverse.
const ERROR_CODES: Record<ErrorCode, true> = {
  'invalid-argument': true,
  'permission-denied': true,
  'not-found': true,
  'already-exists': true,
  'failed-precondition': true,
  conflict: true,
  starting: true,
  unavailable: true,
  'payload-too-large': true,
  'resource-exhausted': true,
  'unsupported-media-type': true,
  internal: true,
}

// Google's canonical statuses, as native mounts and Firestore REST answer
// them (`{ error: { code: 404, status: "NOT_FOUND" } }`).
const GOOGLE_STATUS: Record<string, ErrorCode> = {
  NOT_FOUND: 'not-found',
  ALREADY_EXISTS: 'already-exists',
  FAILED_PRECONDITION: 'failed-precondition',
  ABORTED: 'failed-precondition',
  INVALID_ARGUMENT: 'invalid-argument',
  OUT_OF_RANGE: 'invalid-argument',
  PERMISSION_DENIED: 'permission-denied',
  UNAUTHENTICATED: 'permission-denied',
  RESOURCE_EXHAUSTED: 'resource-exhausted',
  UNAVAILABLE: 'unavailable',
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The one parser every helper uses. Two error bodies reach the console: the
 * console's own `{ error: { code: "not-found", message, fix? } }`, and
 * Google's `{ error: { code: 404, message, status: "NOT_FOUND" } }` from
 * native mounts and Firestore REST, whose `code` is a number. A `code` is
 * taken only when it is one the engine sends; otherwise `status` is mapped.
 */
export function parseErrorBody(
  status: number,
  body: unknown,
  fallback = `${status}`,
): { code: ApiErrorCode; message: string; fix?: string } {
  const error = record(record(body)?.error)
  if (!error) return { code: 'unknown', message: fallback }
  const message =
    typeof error.message === 'string' && error.message !== '' ? error.message : fallback
  if (isErrorCode(error.code)) {
    return typeof error.fix === 'string'
      ? { code: error.code, message, fix: error.fix }
      : { code: error.code, message }
  }
  const google = typeof error.status === 'string' ? GOOGLE_STATUS[error.status] : undefined
  return { code: google ?? 'unknown', message }
}

/** An `ApiError` from a failed response, whatever its body holds. */
async function failure(response: Response): Promise<ApiError> {
  const fallback = `${response.status} ${response.statusText}`.trim()
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A non-JSON body (a proxy's HTML page) keeps the status line.
    body = undefined
  }
  const parsed = parseErrorBody(response.status, body, fallback)
  return new ApiError(response.status, parsed.message, parsed.code, parsed.fix)
}

/** `fetch`, with a failure to answer turned into a `network` error. */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    // An abort is the caller's own decision, not a failure to report.
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new ApiError(0, `The engine did not answer: ${reason}`, 'network')
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw await failure(response)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** `GET <API_BASE><path>?<params>`; `undefined` params are left out. */
export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) search.set(key, String(value))
  }
  const query = search.size > 0 ? `?${search}` : ''
  const response = await send(`${API_BASE}${path}${query}`, {
    signal: signal ?? null,
    headers: { accept: 'application/json', [CONSOLE_HEADER]: '1' },
  })
  return json<T>(response)
}

/**
 * A change through the Console API. The body is always JSON (`{}` when
 * `body` is `undefined`) and carries the console header, which the engine's
 * guard requires of every mutation.
 */
export async function apiSend<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  options?: {
    signal?: AbortSignal
    /** `x-firenook-console` value; default '1' (auth uses 'write', 'try', 'replay'). */
    origin?: string
  },
): Promise<T> {
  const response = await send(`${API_BASE}${path}`, {
    method,
    signal: options?.signal ?? null,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      [CONSOLE_HEADER]: options?.origin ?? '1',
    },
    body: JSON.stringify(body ?? {}),
  })
  return json<T>(response)
}

/**
 * A native mount or Firestore REST call: the same error parsing, never
 * prefixed with `API_BASE` twice; adds `x-firenook-console: 1` unless
 * `init.headers` already sets it. Resolves with the response when it is OK.
 */
export async function nativeFetch(url: string, init: RequestInit): Promise<Response> {
  const target =
    url.startsWith(API_BASE) || /^[a-z][a-z0-9+.-]*:/i.test(url)
      ? url
      : `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`
  const headers = new Headers(init.headers)
  if (!headers.has(CONSOLE_HEADER)) headers.set(CONSOLE_HEADER, '1')
  const response = await send(target, { ...init, headers })
  if (!response.ok) throw await failure(response)
  return response
}

export const api = {
  status: (): Promise<ConsoleStatus> => apiGet<ConsoleStatus>('/status'),
}
