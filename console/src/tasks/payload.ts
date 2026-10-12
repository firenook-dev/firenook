// What the Enqueue dialog sends, built the way the engine builds it: the
// task object `firebase-admin`'s `TaskQueue.enqueue` posts (the body is
// `{"data": …}` base64, or a raw JSON body as it is), measured the way the
// Tasks port measures it — the JSON request `{"task": …}` against
// `express.json`'s 100 KiB — so the dialog can say a task is too large
// before the engine refuses it with the same figure. The engine checks
// again; this is the early warning, never the authority.
//
// Also the payloads a queue was sent recently (TK-43), per browser.

import type { TasksEnqueueBody } from '@/api/generated/messaging/TasksEnqueueBody'
import type { TasksHeader } from '@/api/generated/messaging/TasksHeader'

/** The Tasks port's request limit (`express.json`'s 100 KiB). */
export const REQUEST_LIMIT = 100 * 1024

/** The Admin SDK's own deadline when none is given, seconds. */
export const DEFAULT_DEADLINE = 60

/** The deadlines Cloud Tasks accepts, seconds. */
export const DEADLINE_RANGE = [15, 1800] as const

export type SendAs = 'data' | 'raw'

/** The dialog's fields, as typed. */
export interface EnqueueDraft {
  sendAs: SendAs
  /** JSON text: the `data` member, or the whole body. */
  text: string
  /** The task id; empty lets the emulator generate a name. */
  id: string
  headers: readonly TasksHeader[]
  /** Seconds; empty or 0 sends no schedule time. */
  delay: string
  /** Seconds; empty sends no deadline (the emulator's 60 s). */
  deadline: string
  /** Empty: the queue's `defaultUri`. */
  url: string
}

/** A new draft: empty data (`{}`), as `enqueue({})` sends it. */
export function emptyDraft(): EnqueueDraft {
  return { sendAs: 'data', text: '{}', id: '', headers: [], delay: '', deadline: '', url: '' }
}

/** A queue's address as the task name spells it. */
export interface QueueParts {
  project: string
  location: string
  id: string
}

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }

/** JSON text parsed, with the parser's own words when it is not JSON. */
export function parseJson(text: string): Checked<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The body the request carries, decoded: `JSON.stringify({ data })` as the
 * Admin SDK writes it, or the raw JSON body re-serialized (the engine does
 * the same, so whitespace never counts against the limit). Empty data is
 * `{}`, as `enqueue()` with no data sends.
 */
export function bodyOf(draft: Pick<EnqueueDraft, 'sendAs' | 'text'>): Checked<string> {
  const text = draft.text.trim()
  if (draft.sendAs === 'data') {
    if (text === '') return { ok: true, value: '{}' }
    const parsed = parseJson(text)
    if (!parsed.ok) return { ok: false, message: `The data is not valid JSON: ${parsed.message}` }
    return { ok: true, value: JSON.stringify({ data: parsed.value }) }
  }
  if (text === '') return { ok: false, message: 'A raw body needs some JSON.' }
  const parsed = parseJson(text)
  if (!parsed.ok) return { ok: false, message: `The raw body is not valid JSON: ${parsed.message}` }
  return { ok: true, value: JSON.stringify(parsed.value) }
}

const encoder = new TextEncoder()

/** UTF-8 bytes of a string. */
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** Base64 of a string's UTF-8 bytes, as the Admin SDK encodes a task body. */
export function base64Utf8(text: string): string {
  const bytes = encoder.encode(text)
  let binary = ''
  // In slices: String.fromCharCode takes its arguments on the stack.
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

/** The base64 text length of `bytes` bytes. */
function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3)
}

/** A task id the Admin SDK accepts: letters, digits, `-` and `_`, at most 500. */
export function taskIdProblem(id: string): string | undefined {
  if (id === '') return undefined
  if (id.length > 500 || !/^[A-Za-z0-9_-]+$/.test(id))
    return 'A task id holds only letters, digits, hyphens and underscores, at most 500.'
  return undefined
}

/** The delay in seconds, or a sentence; empty is no delay. */
export function delayOf(text: string): Checked<number | undefined> {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: undefined }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0)
    return { ok: false, message: 'The delay is a number of seconds, 0 or more.' }
  return { ok: true, value: value === 0 ? undefined : value }
}

/** The dispatch deadline in whole seconds, or a sentence; empty is the emulator's default. */
export function deadlineOf(text: string): Checked<number | undefined> {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: undefined }
  const value = Number(trimmed)
  const [low, high] = DEADLINE_RANGE
  if (!Number.isInteger(value) || value < low || value > high)
    return { ok: false, message: `The dispatch deadline is whole seconds from ${low} to ${high}.` }
  return { ok: true, value }
}

/** An http(s) URL, or a sentence; empty is the queue's default. */
export function urlProblem(url: string): string | undefined {
  const trimmed = url.trim()
  if (trimmed === '') return undefined
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return undefined
  } catch {
    // Not a URL at all: said below.
  }
  return 'The URL must be an absolute http or https URL.'
}

/**
 * The request the Admin SDK would send for this draft, as the Tasks port
 * measures it: `JSON.stringify({ task })`, in UTF-8 bytes. The body is
 * measured as its base64 length, which is all base64 text adds to JSON.
 */
export function requestSize(
  draft: EnqueueDraft,
  parts: QueueParts,
  now = Date.now(),
): Checked<number> {
  const body = bodyOf(draft)
  if (!body.ok) return body
  const delay = delayOf(draft.delay)
  if (!delay.ok) return delay
  const deadline = deadlineOf(draft.deadline)
  if (!deadline.ok) return deadline
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  for (const header of draft.headers) headers[header.name] = header.value
  const task: Record<string, unknown> = {
    httpRequest: {
      url: draft.url.trim(),
      oidcToken: { serviceAccountEmail: 'emulated-service-acct@email.com' },
      body: '',
      headers,
    },
  }
  if (delay.value !== undefined)
    task.scheduleTime = new Date(now + delay.value * 1000).toISOString()
  if (deadline.value !== undefined) task.dispatchDeadline = `${deadline.value}s`
  const id = draft.id.trim()
  if (id !== '')
    task.name = `projects/${parts.project}/locations/${parts.location}/queues/${parts.id}/tasks/${id}`
  const envelope = byteLength(JSON.stringify({ task }))
  return { ok: true, value: envelope + base64Length(byteLength(body.value)) }
}

/** The sentence for a request over the limit, the engine's own words; nothing under it. */
export function sizeProblem(size: number): string | undefined {
  if (size <= REQUEST_LIMIT) return undefined
  return `The Tasks port accepts requests up to ${REQUEST_LIMIT / 1024} KiB, as express.json does; this one would be ${Math.ceil(size / 1024)} KiB.`
}

/** What `POST /tasks/tasks` takes for the draft (the engine builds the task from it). */
export function enqueueBody(queue: string, draft: EnqueueDraft): TasksEnqueueBody {
  const text = draft.text.trim()
  const delay = delayOf(draft.delay)
  const deadline = deadlineOf(draft.deadline)
  const body: TasksEnqueueBody = { queue, headers: draft.headers.filter((h) => h.name !== '') }
  if (draft.sendAs === 'data') {
    if (text !== '') body.data = text
  } else body.rawBody = text
  if (draft.id.trim() !== '') body.name = draft.id.trim()
  if (delay.ok && delay.value !== undefined) body.scheduleDelaySeconds = delay.value
  if (deadline.ok && deadline.value !== undefined) body.dispatchDeadlineSeconds = deadline.value
  if (draft.url.trim() !== '') body.url = draft.url.trim()
  return body
}

/**
 * A task's caller headers as the dialog prefills them: `Content-Type`
 * goes, because the Admin SDK always sets it (the engine adds it again).
 */
export function callerHeaders(headers: readonly TasksHeader[]): TasksHeader[] {
  return headers.filter((header) => header.name.toLowerCase() !== 'content-type')
}

/**
 * The draft for "Edit and enqueue a copy" of a task the console holds:
 * the `data` member when the body is the Admin SDK's shape, else the raw
 * body; its caller headers, deadline and URL; never its name (a used name
 * is refused for the rest of the run).
 */
export function draftFrom(detail: {
  body: string
  data: string | null
  headers: readonly TasksHeader[]
  task: { deadlineSeconds: number; url: string | null }
}): EnqueueDraft {
  const pretty = (text: string) => {
    const parsed = parseJson(text)
    return parsed.ok ? JSON.stringify(parsed.value, null, 2) : text
  }
  return {
    sendAs: detail.data === null ? 'raw' : 'data',
    text: pretty(detail.data ?? detail.body),
    id: '',
    headers: callerHeaders(detail.headers),
    delay: '',
    deadline:
      detail.task.deadlineSeconds === DEFAULT_DEADLINE ? '' : String(detail.task.deadlineSeconds),
    url: detail.task.url ?? '',
  }
}

// ------------------------------------------------------------ recent payloads

/** One payload a queue was sent from this browser. */
export interface RecentPayload {
  sendAs: SendAs
  text: string
  at: string
}

/** How many a queue keeps. */
export const RECENT_LIMIT = 10

const recentKey = (queue: string) => `firenook.console.tasks.payloads.${queue}`

/** The payloads this browser sent `queue`, newest first. */
export function recentPayloads(queue: string): RecentPayload[] {
  try {
    const stored = localStorage.getItem(recentKey(queue))
    if (!stored) return []
    const parsed = JSON.parse(stored) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is RecentPayload =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry.sendAs === 'data' || entry.sendAs === 'raw') &&
          typeof entry.text === 'string' &&
          typeof entry.at === 'string',
      )
      .slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

/** Keeps a payload first in `queue`'s list, the same text once. */
export function rememberPayload(
  queue: string,
  payload: Omit<RecentPayload, 'at'>,
  now = Date.now(),
) {
  const entry: RecentPayload = { ...payload, at: new Date(now).toISOString() }
  const kept = recentPayloads(queue).filter(
    (other) => other.text !== entry.text || other.sendAs !== entry.sendAs,
  )
  try {
    localStorage.setItem(recentKey(queue), JSON.stringify([entry, ...kept].slice(0, RECENT_LIMIT)))
  } catch {
    // A browser that refuses storage keeps no recent payloads.
  }
}
