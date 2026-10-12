// A callable function's protocol, as the Functions SDK speaks it: the
// request is `{"data": …}`, the answer `{"result": …}` or `{"error":
// {status, message, details}}`, a streaming call answers server-sent
// events (`data: {"message": …}` for each chunk, then `data: {"result": …}`),
// and App Check rides in `X-Firebase-AppCheck`. The emulator does not
// verify tokens, so an unsigned App Check token with the claims the SDK
// reads is enough for a handler to see `request.app`.

/** The request body: the data wrapped as the SDK wraps it. */
export function callableBody(dataText: string): string {
  const data = dataText.trim() === '' ? null : (JSON.parse(dataText) as unknown)
  return JSON.stringify({ data })
}

/** The project number in an app id (`1:123456:web:abc` → `123456`), when it has one. */
export function projectNumberOf(appId: string): string | undefined {
  return /^\d+:(\d+):/.exec(appId.trim())?.[1]
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The claims of an App Check token for `appId` in `projectId`, issued `now` (seconds) for an hour. */
export function appCheckClaims(
  appId: string,
  projectId: string,
  now: number = Math.floor(Date.now() / 1000),
) {
  const number = projectNumberOf(appId) ?? '0'
  return {
    iss: `https://firebaseappcheck.googleapis.com/${number}`,
    aud: [`projects/${number}`, `projects/${projectId}`],
    sub: appId.trim(),
    iat: now,
    exp: now + 3600,
  }
}

/** An unsigned App Check token the emulator accepts (`alg: none`; nothing here works against production). */
export function appCheckToken(appId: string, projectId: string, now?: number): string {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  return `${header}.${base64url(JSON.stringify(appCheckClaims(appId, projectId, now)))}.`
}

/** How a callable answered, read the way the SDK reads it. */
export type CallableAnswer =
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; status: string; message: string; details: unknown }
  /** A streamed call: each chunk's message as it came, then its result or error. */
  | {
      kind: 'stream'
      chunks: unknown[]
      result?: unknown
      error?: { status: string; message: string; details: unknown } | undefined
      done: boolean
    }
  /** Not the callable protocol: the HTTP status and the text, said as they are. */
  | { kind: 'other'; status: number; text: string }

function errorOf(
  value: unknown,
): { status: string; message: string; details: unknown } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const error = (value as Record<string, unknown>).error
  if (error === null || typeof error !== 'object') return undefined
  const fields = error as Record<string, unknown>
  return {
    status: typeof fields.status === 'string' ? fields.status : 'UNKNOWN',
    message: typeof fields.message === 'string' ? fields.message : '',
    details: fields.details,
  }
}

/** The server-sent events of a streaming answer, read so far (a partial last line waits). */
export function readStream(text: string): Extract<CallableAnswer, { kind: 'stream' }> {
  const answer: Extract<CallableAnswer, { kind: 'stream' }> = {
    kind: 'stream',
    chunks: [],
    done: false,
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    let value: unknown
    try {
      value = JSON.parse(line.slice(5).trim())
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object') continue
    const fields = value as Record<string, unknown>
    if ('message' in fields) answer.chunks.push(fields.message)
    else if ('result' in fields) {
      answer.result = fields.result
      answer.done = true
    } else {
      const error = errorOf(value)
      if (error) {
        answer.error = error
        answer.done = true
      }
    }
  }
  return answer
}

/** A callable's answer from its status, content type and body text. */
export function readCallableResponse(
  status: number,
  contentType: string | undefined,
  text: string,
): CallableAnswer {
  if (/text\/event-stream/i.test(contentType ?? '')) return readStream(text)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'other', status, text }
  }
  const error = errorOf(value)
  if (error) return { kind: 'error', ...error }
  if (value !== null && typeof value === 'object' && 'result' in value)
    return { kind: 'result', result: (value as Record<string, unknown>).result }
  return { kind: 'other', status, text }
}
