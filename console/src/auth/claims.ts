// Custom claims as the claims editor checks them while they are typed —
// with Firebase's own rules, so Save knows before it is pressed what the
// emulator (and production) would refuse:
//
// - the text must be JSON, and a JSON object (`INVALID_CLAIMS`);
// - no reserved key (`FORBIDDEN_CLAIM`: the sixteen names the token itself
//   uses, from `iss` to `firebase`);
// - at most 1,000 characters, counted as JavaScript counts a string's
//   length — UTF-16 code units — of the compact JSON, which is what the
//   official emulator measures (`claims.length`), not UTF-8 bytes:
//   `{"n":"é"}` is 9 characters and `{"n":"🔥"}` is 10.

import type { CodeMark } from '@/components/code-editor/props'

/** The claims Firebase reserves for the token itself (`FORBIDDEN_CLAIM`). */
export const FORBIDDEN_CLAIMS: readonly string[] = [
  'acr',
  'amr',
  'at_hash',
  'aud',
  'auth_time',
  'azp',
  'cnf',
  'c_hash',
  'exp',
  'firebase',
  'iat',
  'iss',
  'jti',
  'nbf',
  'nonce',
  'sub',
]

/** The most characters custom claims may hold (`CLAIMS_TOO_LARGE` above it). */
export const CLAIMS_LIMIT = 1_000
/** From here the meter turns amber: close enough to the limit to be worth seeing. */
export const CLAIMS_CROWDED = 900

/** What the claims text is, read for saving. */
export type ClaimsReading =
  | { ok: true; claims: Record<string, unknown>; compact: string; length: number }
  | { ok: false; message: string }

/** The length Firebase measures: JavaScript string length of the compact JSON. */
export function claimsLength(text: string): number {
  return JSON.stringify(JSON.parse(text)).length
}

/**
 * What the claims meter reads for the text: the length Firebase measures
 * as soon as the text is JSON (an empty box is `{}`), whatever else Firebase
 * would refuse in it — a reserved key or a value that is not an object is
 * said beside the meter, not by it. Undefined while the text is not JSON.
 */
export function meteredLength(text: string): number | undefined {
  if (text.trim() === '') return 2
  try {
    return claimsLength(text)
  } catch {
    return undefined
  }
}

/** Where `JSON.parse` stopped, as an offset into the text, from its message. */
export function parseErrorOffset(text: string, message: string): number {
  const position = /position (\d+)/.exec(message)
  if (position) return Math.min(text.length, Number(position[1]))
  const lineColumn = /line (\d+) column (\d+)/.exec(message)
  if (lineColumn) {
    const lines = text.split('\n')
    const line = Math.max(1, Number(lineColumn[1]))
    let offset = 0
    for (let index = 0; index < line - 1 && index < lines.length; index += 1)
      offset += (lines[index]?.length ?? 0) + 1
    return Math.min(text.length, offset + Math.max(0, Number(lineColumn[2]) - 1))
  }
  return text.length
}

/** The claims text read for saving: the claims, their compact JSON and its length, or why not. */
export function readClaims(text: string): ClaimsReading {
  if (text.trim() === '') return { ok: true, claims: {}, compact: '{}', length: 2 }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, message: `This is not JSON yet: ${(error as Error).message}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return {
      ok: false,
      message: 'Custom claims must be a JSON object, like {"role": "admin"} (INVALID_CLAIMS).',
    }
  const forbidden = Object.keys(parsed).find((key) => FORBIDDEN_CLAIMS.includes(key))
  if (forbidden !== undefined)
    return {
      ok: false,
      message: `\`${forbidden}\` is reserved; Firebase refuses it (FORBIDDEN_CLAIM).`,
    }
  const compact = JSON.stringify(parsed)
  if (compact.length > CLAIMS_LIMIT)
    return {
      ok: false,
      message: 'Custom claims are over 1,000 characters; Firebase refuses them (CLAIMS_TOO_LARGE).',
    }
  return { ok: true, claims: parsed as Record<string, unknown>, compact, length: compact.length }
}

/** One top-level key of a JSON object, where its quoted name stands in the text. */
export interface KeySpan {
  key: string
  from: number
  to: number
}

/**
 * The top-level keys of the object the text holds, with the span of each
 * quoted name. Forgiving, because the text is being typed: it stops at the
 * first thing it cannot read and returns what it found.
 */
export function topLevelKeySpans(text: string): KeySpan[] {
  const spans: KeySpan[] = []
  let at = 0
  let depth = 0
  let expectKey = false
  while (at < text.length) {
    const char = text[at]
    if (char === '"') {
      const from = at
      at += 1
      while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1
      at += 1
      if (depth === 1 && expectKey) {
        try {
          spans.push({ key: JSON.parse(text.slice(from, at)) as string, from, to: at })
        } catch {
          return spans
        }
        expectKey = false
      }
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      if (depth === 1 && char === '{') expectKey = true
    } else if (char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 1) expectKey = true
    at += 1
  }
  return spans
}

/** How the meter reads: quiet, crowded (amber from 900) or over (red above 1,000). */
export function meterTone(length: number): 'quiet' | 'crowded' | 'over' {
  if (length > CLAIMS_LIMIT) return 'over'
  if (length >= CLAIMS_CROWDED) return 'crowded'
  return 'quiet'
}

/**
 * The marks the editor shows: where the JSON stops parsing, a value that
 * is not an object, and every reserved key on its own span. Notes from the
 * token preview (claims Auth replaces, or that replace a profile claim)
 * are added by the caller, which has the minted token.
 */
export function claimsMarks(text: string): CodeMark[] {
  if (text.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const message = (error as Error).message
    const at = parseErrorOffset(text, message)
    return [
      {
        from: Math.max(0, Math.min(at, text.length - 1)),
        to: Math.min(text.length, Math.max(at, 0) + 1),
        severity: 'error',
        message: `This is not JSON yet: ${message}`,
      },
    ]
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return [
      {
        from: 0,
        to: text.length,
        severity: 'error',
        message: 'Custom claims must be a JSON object, like {"role": "admin"} (INVALID_CLAIMS).',
      },
    ]
  return topLevelKeySpans(text)
    .filter((span) => FORBIDDEN_CLAIMS.includes(span.key))
    .map((span) => ({
      from: span.from,
      to: span.to,
      severity: 'error' as const,
      message: `\`${span.key}\` is reserved; Firebase refuses it (FORBIDDEN_CLAIM).`,
    }))
}

/** Marks on keys the minted token says something about: shadowed (warning) or overriding (info). */
export function noteMarks(
  text: string,
  notes: {
    shadowed: readonly { key: string; reason: string }[]
    overrides: readonly { key: string; reason: string }[]
  },
): CodeMark[] {
  const spans = topLevelKeySpans(text)
  const marks: CodeMark[] = []
  for (const note of notes.shadowed)
    for (const span of spans.filter((candidate) => candidate.key === note.key))
      marks.push({ from: span.from, to: span.to, severity: 'warning', message: note.reason })
  for (const note of notes.overrides)
    for (const span of spans.filter((candidate) => candidate.key === note.key))
      marks.push({ from: span.from, to: span.to, severity: 'info', message: note.reason })
  return marks
}

/** The stored claims as the editor opens them: indented, or empty for none. */
export function claimsText(claims: Record<string, unknown> | null): string {
  if (!claims || Object.keys(claims).length === 0) return ''
  return JSON.stringify(claims, null, 2)
}

/**
 * The claims text with one more key (a key other users carry, with one of
 * their values), re-indented; the text as it was when it is not an object
 * yet or already has the key.
 */
export function addClaimKey(text: string, key: string, value: unknown): string {
  if (text.trim() === '') return JSON.stringify({ [key]: value ?? null }, null, 2)
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return text
    if (Object.hasOwn(parsed, key)) return text
    return JSON.stringify({ ...(parsed as Record<string, unknown>), [key]: value ?? null }, null, 2)
  } catch {
    return text
  }
}

/** The text indented two spaces, or `undefined` while it is not JSON. */
export function formatClaims(text: string): string | undefined {
  if (text.trim() === '') return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return undefined
  }
}
