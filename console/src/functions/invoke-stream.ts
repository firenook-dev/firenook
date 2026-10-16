// An invocation the console makes, read as it happens: Invoke, a test
// event and a replay answer with one JSON frame per line (NDJSON, compute
// spec §6.4) — `started` with the invocation at once, `head` with the
// status and headers, `chunk`s of the body as the function writes them,
// `truncated` past 4 MiB, then `finished`; or `failed` at any point.
//
// A tab keeps at most one of these open. An invoke can stay open for the
// function's timeout (60 s by default, without limit under
// `--inspect-functions`), and on plain http a tab shares six connections
// with everything else it asks, so a second Send stops waiting on the
// first. Stopping only stops the waiting: the engine's dispatch runs on
// its own task, finishes and is recorded, and its result still reaches
// the page on `functions.events`. Each stream also holds one of the tab's
// long-request slots while it is open (`lib/long-requests.ts`).

import { API_BASE, ApiError, parseErrorBody } from '@/api/client'
import type { FunctionHeader } from '@/api/generated/compute/FunctionHeader'
import type { FunctionInvokeRequest } from '@/api/generated/compute/FunctionInvokeRequest'
import type { FunctionTestEventRequest } from '@/api/generated/compute/FunctionTestEventRequest'
import type { InvocationFrame } from '@/api/generated/compute/InvocationFrame'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import type { ResponseRecord } from '@/components/console/request/types'
import { longRequests } from '@/lib/long-requests'

export type { InvocationFrame }

const enc = encodeURIComponent

/**
 * Cuts text that arrives in pieces into whole lines: a frame split across
 * two reads is held until its newline comes. `end` hands over what is left.
 */
export function createLineSplitter() {
  let pending = ''
  return {
    push(text: string): string[] {
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      return lines.filter((line) => line.trim() !== '')
    },
    end(): string[] {
      const rest = pending
      pending = ''
      return rest.trim() === '' ? [] : [rest]
    },
  }
}

/** A line as a frame, or undefined for a line that is not one. */
export function parseFrame(line: string): InvocationFrame | undefined {
  try {
    const value = JSON.parse(line) as unknown
    if (typeof value === 'object' && value !== null && 'frame' in value)
      return value as InvocationFrame
  } catch {
    // Not JSON: said by the caller.
  }
  return undefined
}

/** How a stream ended: what the engine said, or that the console stopped waiting. */
export interface StreamOutcome {
  /** The invocation, as soon as the engine began it (`started`). */
  started?: InvocationSummary
  /** The invocation as it finished (`finished`): outcome, status, duration. */
  finished?: InvocationSummary
  /** What went wrong after the request was accepted (`failed`, or a broken stream), in a sentence. */
  failed?: string
  /** The console stopped waiting (Stop waiting, or a newer stream in this tab); the engine carries on. */
  stopped: boolean
}

/** The tab's one open invoke stream. */
let current: AbortController | undefined

/** Stops waiting on the tab's open invoke stream, if there is one. */
export function stopWaiting(): void {
  current?.abort()
}

/**
 * Posts `body` to an NDJSON route and hands each frame to `onFrame` as it
 * arrives. A refusal before the stream starts (an unknown function, a bad
 * header, a body over the limit) is thrown as `ApiError`; everything after
 * that resolves, the way it ended included.
 */
export async function streamFrames(
  path: string,
  body: unknown,
  options: { signal?: AbortSignal | undefined; onFrame?: (frame: InvocationFrame) => void } = {},
): Promise<StreamOutcome> {
  current?.abort()
  const controller = new AbortController()
  current = controller
  const forward = () => controller.abort()
  options.signal?.addEventListener('abort', forward, { once: true })
  if (options.signal?.aborted) controller.abort()

  const outcome: StreamOutcome = { stopped: false }
  let release: (() => void) | undefined
  try {
    try {
      release = await longRequests.acquire(controller.signal)
    } catch {
      return { ...outcome, stopped: true }
    }
    let response: Response
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          accept: 'application/x-ndjson',
          'content-type': 'application/json',
          'x-firenook-console': '1',
        },
        body: JSON.stringify(body ?? {}),
      })
    } catch (error) {
      if (controller.signal.aborted) return { ...outcome, stopped: true }
      const reason = error instanceof Error ? error.message : String(error)
      throw new ApiError(0, `The engine did not answer: ${reason}`, 'network')
    }
    if (!response.ok) {
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch {
        parsed = undefined
      }
      const error = parseErrorBody(
        response.status,
        parsed,
        `${response.status} ${response.statusText}`.trim(),
      )
      throw new ApiError(response.status, error.message, error.code, error.fix)
    }
    if (!response.body) return { ...outcome, failed: 'The engine answered without a stream.' }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const lines = createLineSplitter()
    const take = (line: string): boolean => {
      const frame = parseFrame(line)
      if (!frame) {
        outcome.failed = 'The engine sent a line that is not a frame; the stream was stopped.'
        return false
      }
      if (frame.frame === 'started') outcome.started = frame.invocation
      else if (frame.frame === 'finished') outcome.finished = frame.invocation
      else if (frame.frame === 'failed') outcome.failed = frame.message
      options.onFrame?.(frame)
      return true
    }
    try {
      for (;;) {
        // Frames arrive one after another; there is nothing to run in parallel.
        // oxlint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read()
        if (done) break
        for (const line of lines.push(decoder.decode(value, { stream: true }))) {
          if (!take(line)) {
            void reader.cancel()
            return outcome
          }
        }
      }
      for (const line of [...lines.push(decoder.decode()), ...lines.end()]) {
        if (!take(line)) return outcome
      }
    } catch (error) {
      if (controller.signal.aborted) return { ...outcome, stopped: true }
      const reason = error instanceof Error ? error.message : String(error)
      return { ...outcome, failed: `The stream broke before the invocation finished: ${reason}` }
    }
    if (!outcome.finished && !outcome.failed)
      outcome.failed = 'The stream ended before the invocation finished.'
    return outcome
  } finally {
    release?.()
    options.signal?.removeEventListener('abort', forward)
    if (current === controller) current = undefined
  }
}

/** Calls a function as the console (`POST /functions/{id}/invoke`): by its URL, or by its trigger route. */
export function invokeFunction(
  id: string,
  request: FunctionInvokeRequest,
  options?: Parameters<typeof streamFrames>[2],
): Promise<StreamOutcome> {
  return streamFrames(`/functions/${enc(id)}/invoke`, request, options)
}

/** Posts a test event, the exact envelope the official functions shell builds, to a background function. */
export function sendTestEvent(
  id: string,
  request: FunctionTestEventRequest,
  options?: Parameters<typeof streamFrames>[2],
): Promise<StreamOutcome> {
  return streamFrames(`/functions/${enc(id)}/send-event`, request, options)
}

/** Runs a recorded invocation again with the same request (its secrets read in the engine), against the code loaded now. */
export function replayInvocation(
  invocation: string,
  options?: Parameters<typeof streamFrames>[2],
): Promise<StreamOutcome> {
  return streamFrames(`/functions/invocations/${enc(invocation)}/replay`, {}, options)
}

// ── The answer, for the kit's ResponseView ───────────────────────────────

function decodeBase64(text: string): Uint8Array {
  try {
    const binary = atob(text)
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return new Uint8Array()
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let at = 0; at < bytes.length; at += step)
    binary += String.fromCharCode(...bytes.subarray(at, at + step))
  return btoa(binary)
}

function header(headers: readonly FunctionHeader[], name: string): string | undefined {
  return headers.find((entry) => entry.name.toLowerCase() === name)?.value ?? undefined
}

/**
 * Builds the `ResponseRecord` the request kit's `ResponseView` draws, frame
 * by frame, so the answer shows while it arrives: the head's status and
 * headers, each chunk as it came (text, or bytes the engine sent as
 * base64), and the end. `at` is when the console sent it; times are the
 * console's own clock from then, except the duration, which is the
 * engine's once the invocation finished.
 */
export function createResponseBuilder(at: string, now: () => number = () => performance.now()) {
  const started = now()
  const since = () => now() - started
  let record: ResponseRecord = {
    status: 0,
    statusText: '',
    headers: [],
    durationMs: 0,
    sizeBytes: 0,
    at,
  }
  const parts: Uint8Array[] = []
  const chunks: { atMs: number; text: string }[] = []
  let binary = false
  const encoder = new TextEncoder()

  const body = (): Pick<ResponseRecord, 'bodyText' | 'bodyBase64'> => {
    if (parts.length === 0) return {}
    if (!binary) return { bodyText: chunks.map((chunk) => chunk.text).join('') }
    const size = parts.reduce((sum, part) => sum + part.length, 0)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    return { bodyBase64: toBase64(bytes) }
  }

  return {
    /** The record after this frame (a new object each time). */
    apply(frame: InvocationFrame): ResponseRecord {
      switch (frame.frame) {
        case 'started':
          record = { ...record, receiving: true }
          break
        case 'head': {
          const contentType = header(frame.headers, 'content-type')
          record = {
            ...record,
            status: frame.status,
            headers: frame.headers.map((entry) => [entry.name, entry.value ?? '']),
            ...(contentType === undefined ? {} : { contentType }),
            durationMs: since(),
            receiving: true,
          }
          break
        }
        case 'chunk': {
          const atMs = since()
          const bytes =
            frame.encoding === 'base64' ? decodeBase64(frame.text) : encoder.encode(frame.text)
          if (frame.encoding === 'base64') binary = true
          parts.push(bytes)
          chunks.push({ atMs, text: frame.encoding === 'base64' ? '' : frame.text })
          record = {
            ...record,
            firstByteMs: record.firstByteMs ?? atMs,
            durationMs: atMs,
            sizeBytes: record.sizeBytes + bytes.length,
            chunks: chunks.filter((chunk) => chunk.text !== ''),
            ...body(),
            receiving: true,
          }
          break
        }
        case 'truncated':
          record = { ...record, sizeBytes: frame.total, truncated: true }
          break
        case 'finished': {
          const { receiving: _receiving, ...rest } = record
          record = {
            ...rest,
            durationMs: frame.invocation.durationMs ?? since(),
            ...(record.firstByteMs === undefined && record.status !== 0
              ? { firstByteMs: record.durationMs }
              : {}),
          }
          if (record.status === 0 && frame.invocation.status !== null)
            record = { ...record, status: frame.invocation.status }
          break
        }
        case 'failed': {
          const { receiving: _receiving, ...rest } = record
          record = { ...rest, durationMs: since(), error: frame.message }
          break
        }
      }
      return record
    },
  }
}
