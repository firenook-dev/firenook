// Saved tests: the Lambda test-event habit, for every Run form. A saved
// entry is the whole draft — a test event's envelope, a request's method,
// path, query, headers, body and who it is sent as, never a token — named,
// per function, in this browser's localStorage under the project (at most
// 50 per function and 1 MB per project; past either, the save says so and
// offers Export). Export writes `<function>.tests.json`, Import reads the
// same shape back, merged by name, so a team can share them.

import { useSyncExternalStore } from 'react'
import type { CallableDraft, EventDraft, InvokeDraft } from './run-drafts'

/** Saved tests per function. */
export const SAVED_PER_FUNCTION = 50
/** UTF-8 bytes per project. */
export const SAVED_BYTES = 1024 * 1024

export type SavedKind = 'event' | 'request' | 'callable'

export interface SavedTest {
  name: string
  kind: SavedKind
  draft: InvokeDraft | CallableDraft | EventDraft
  savedAt: string
}

/** The export file's shape. */
export interface SavedTestsFile {
  version: 1
  function: string
  saved: { name: string; kind: SavedKind; draft: SavedTest['draft'] }[]
}

type ProjectTests = Record<string, SavedTest[]>

const PREFIX = 'firenook.console.saved-tests.'

const listeners = new Set<() => void>()
const memory = new Map<string, string>()
let cache: { key: string; raw: string | null; value: ProjectTests } | undefined

function read(project: string): ProjectTests {
  const key = PREFIX + project
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    raw = memory.get(key) ?? null
  }
  if (cache?.key === key && cache.raw === raw) return cache.value
  let value: ProjectTests = {}
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      value = parsed as ProjectTests
  } catch {
    value = {}
  }
  cache = { key, raw, value }
  return value
}

function write(project: string, tests: ProjectTests): void {
  const key = PREFIX + project
  const text = JSON.stringify(tests)
  try {
    localStorage.setItem(key, text)
  } catch {
    memory.set(key, text)
  }
  cache = undefined
  for (const listener of listeners) listener()
}

/** UTF-8 bytes of a value as it is kept. */
export function keptBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

const NONE: readonly SavedTest[] = []

/** One function's saved tests, newest first (the same array until they change). */
export function savedTests(project: string, functionId: string): readonly SavedTest[] {
  return read(project)[functionId] ?? NONE
}

/** Saves (or replaces by name) a test; answers why not when a cap would be passed. */
export function saveTest(
  project: string,
  functionId: string,
  test: Omit<SavedTest, 'savedAt'>,
  now: Date = new Date(),
): { ok: true } | { refused: string } {
  const name = test.name.trim()
  if (name === '') return { refused: 'Name the test.' }
  const tests = read(project)
  const current = tests[functionId] ?? []
  const rest = current.filter((entry) => entry.name !== name)
  if (rest.length >= SAVED_PER_FUNCTION)
    return {
      refused: `${functionId} has ${SAVED_PER_FUNCTION} saved tests, the most kept per function. Export them and delete some first.`,
    }
  const next: ProjectTests = {
    ...tests,
    [functionId]: [{ ...test, name, savedAt: now.toISOString() }, ...rest],
  }
  if (keptBytes(next) > SAVED_BYTES)
    return {
      refused:
        'Saved tests for this project would pass 1 MB, the most kept in this browser. Export them and delete some first.',
    }
  write(project, next)
  return { ok: true }
}

export function deleteTest(project: string, functionId: string, name: string): void {
  const tests = read(project)
  write(project, {
    ...tests,
    [functionId]: (tests[functionId] ?? []).filter((entry) => entry.name !== name),
  })
}

/** The export file for one function's tests. */
export function exportTests(functionId: string, tests: readonly SavedTest[]): string {
  const file: SavedTestsFile = {
    version: 1,
    function: functionId,
    saved: tests.map((test) => ({ name: test.name, kind: test.kind, draft: test.draft })),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

const KINDS: ReadonlySet<string> = new Set<SavedKind>(['event', 'request', 'callable'])

/** Reads an export file for `functionId`; answers what is wrong with it otherwise. */
export function readTestsFile(
  text: string,
  functionId: string,
): { saved: SavedTestsFile['saved'] } | { refused: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { refused: 'The file is not JSON.' }
  }
  if (!value || typeof value !== 'object')
    return { refused: 'The file is not a saved-tests export.' }
  const file = value as Partial<SavedTestsFile>
  if (file.version !== 1) return { refused: 'The file is not a version 1 saved-tests export.' }
  if (file.function !== functionId)
    return { refused: `The file holds tests for ${String(file.function)}, not ${functionId}.` }
  if (!Array.isArray(file.saved)) return { refused: 'The file has no saved tests.' }
  for (const entry of file.saved) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.name !== 'string' ||
      entry.name.trim() === ''
    )
      return { refused: 'Every saved test needs a name.' }
    if (!KINDS.has(entry.kind)) return { refused: `${entry.name} has an unknown kind.` }
    if (
      !entry.draft ||
      typeof entry.draft !== 'object' ||
      (entry.draft as { kind?: unknown }).kind === undefined
    )
      return { refused: `${entry.name} has no draft.` }
  }
  return { saved: file.saved }
}

/** Imports a file's tests, merged by name (the file's win); answers how many, or why not. */
export function importTests(
  project: string,
  functionId: string,
  text: string,
  now: Date = new Date(),
): { imported: number } | { refused: string } {
  const file = readTestsFile(text, functionId)
  if ('refused' in file) return file
  const tests = savedTests(project, functionId)
  const names = new Set(file.saved.map((entry) => entry.name.trim()))
  const merged = [
    ...file.saved.map((entry) => ({
      ...entry,
      name: entry.name.trim(),
      savedAt: now.toISOString(),
    })),
    ...tests.filter((entry) => !names.has(entry.name)),
  ]
  if (merged.length > SAVED_PER_FUNCTION)
    return {
      refused: `That would make ${merged.length} saved tests; ${SAVED_PER_FUNCTION} are kept per function.`,
    }
  const all = { ...read(project), [functionId]: merged }
  if (keptBytes(all) > SAVED_BYTES)
    return { refused: 'That would pass 1 MB of saved tests for this project.' }
  write(project, all)
  return { imported: file.saved.length }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(PREFIX)) {
      cache = undefined
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** One function's saved tests, kept current across this tab and others. */
export function useSavedTests(project: string, functionId: string): readonly SavedTest[] {
  return useSyncExternalStore(
    subscribe,
    () => savedTests(project, functionId),
    () => savedTests(project, functionId),
  )
}
