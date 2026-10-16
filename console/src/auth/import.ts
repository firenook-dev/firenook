// Recognising a users file before it is uploaded: only its first 64 KB are
// read (`Blob.slice`), never the whole file, which may be hundreds of
// megabytes — the engine reads it, user by user, once it is uploaded. The
// three shapes the engine imports:
//
// - the emulator's own export (`accounts.json`): an object whose `kind` is
//   `identitytoolkit#DownloadAccountResponse`, before its `users`;
// - a Firebase CLI `auth:export` file: `{ "users": [...] }`, its users
//   carrying `lastSignedInAt` or production (base64) password hashes;
// - a plain array of users.
//
// Anything else is said at once — "This is not a users export." — rather
// than after an upload.

/** How much of a file is read to recognise it. */
export const IMPORT_PREFIX_BYTES = 65_536

export type ImportShape = 'emulator' | 'cli' | 'array'

export type ImportRecognition =
  | { ok: true; shape: ImportShape; label: string }
  | { ok: false; message: string }

export const NOT_AN_EXPORT =
  'This is not a users export. Expected { "users": [...] } or an array of users.'

const LABELS: Readonly<Record<ImportShape, string>> = {
  emulator: 'An emulator export (accounts.json)',
  cli: 'A Firebase CLI export (auth:export)',
  array: 'A list of users',
}

/** Where the top-level object's keys are, read forgivingly from a prefix that may stop anywhere. */
function topLevelEntries(text: string): { key: string; valueAt: number }[] {
  const entries: { key: string; valueAt: number }[] = []
  let at = 0
  let depth = 0
  let expectKey = false
  let pendingKey: string | undefined
  while (at < text.length) {
    const char = text[at]
    if (char === '"') {
      const from = at
      at += 1
      while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1
      if (at >= text.length) return entries
      at += 1
      if (depth === 1 && expectKey) {
        try {
          pendingKey = JSON.parse(text.slice(from, at)) as string
        } catch {
          return entries
        }
        expectKey = false
      }
      continue
    }
    if (char === ':' && depth === 1 && pendingKey !== undefined) {
      entries.push({ key: pendingKey, valueAt: at + 1 })
      pendingKey = undefined
    } else if (char === '{' || char === '[') {
      depth += 1
      if (depth === 1 && char === '{') expectKey = true
    } else if (char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 1) expectKey = true
    at += 1
  }
  return entries
}

/** The string value at `at`, when it is one and complete. */
function stringAt(text: string, at: number): string | undefined {
  const match = /^\s*("(?:[^"\\]|\\.)*")/.exec(text.slice(at, at + 256))
  if (!match?.[1]) return undefined
  try {
    return JSON.parse(match[1]) as string
  } catch {
    return undefined
  }
}

/** Says what a file's first bytes look like. */
export function detectImportShape(prefix: string): ImportRecognition {
  const text = prefix.replace(/^﻿/, '')
  const first = /\S/.exec(text)
  if (!first) return { ok: false, message: 'This file is empty.' }
  if (first[0] === '[') return { ok: true, shape: 'array', label: LABELS.array }
  if (first[0] !== '{') return { ok: false, message: NOT_AN_EXPORT }
  const entries = topLevelEntries(text)
  const users = entries.findIndex((entry) => entry.key === 'users')
  const kind = entries.find((entry) => entry.key === 'kind')
  const usersEntry = users === -1 ? undefined : entries[users]
  if (!usersEntry) {
    // The prefix may stop before `users` in a big object; only a closed
    // object without it is certainly not an export.
    const closed = (() => {
      try {
        JSON.parse(text)
        return true
      } catch {
        return false
      }
    })()
    return closed
      ? { ok: false, message: NOT_AN_EXPORT }
      : { ok: true, shape: 'cli', label: LABELS.cli }
  }
  if (!/^\s*\[/.test(text.slice(usersEntry.valueAt, usersEntry.valueAt + 64)))
    return { ok: false, message: NOT_AN_EXPORT }
  if (
    kind &&
    kind.valueAt < usersEntry.valueAt &&
    stringAt(text, kind.valueAt) === 'identitytoolkit#DownloadAccountResponse'
  )
    return { ok: true, shape: 'emulator', label: LABELS.emulator }
  return { ok: true, shape: 'cli', label: LABELS.cli }
}

/** Reads a file's first 64 KB and says what it is. */
export async function recogniseImportFile(file: Blob): Promise<ImportRecognition> {
  const prefix = await file.slice(0, IMPORT_PREFIX_BYTES).text()
  return detectImportShape(prefix)
}
