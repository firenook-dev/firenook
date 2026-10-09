// What just changed, and putting it back.
//
// The engine keeps a bounded window of recent commits with the documents
// each one replaced, so an undo restores exactly what was there rather than
// a re-derivation of it, and refuses whole if anything has moved on since.
// Every write reaches it — the console's own, the app's, a trigger's — so
// this is also the quickest answer to "what did my app just do?".
//
// The window holds document data, so the engine keeps it only while
// diagnostics are enabled; the panel says so rather than showing an empty
// list as though nothing had happened.

import { queryOptions } from '@tanstack/react-query'
import { API_BASE, ApiError } from '@/api/client'
import type { ChangeLogPage } from '@/api/generated/ChangeLogPage'
import type { CommitDiff } from '@/api/generated/CommitDiff'
import type { DocumentDiff } from '@/api/generated/DocumentDiff'
import type { FieldChange } from '@/api/generated/FieldChange'
import type { LoggedCommit } from '@/api/generated/LoggedCommit'
import type { LoggedDocument } from '@/api/generated/LoggedDocument'
import type { UndoResult } from '@/api/generated/UndoResult'
import { FS } from './queries'

export type {
  ChangeLogPage,
  CommitDiff,
  DocumentDiff,
  FieldChange,
  LoggedCommit,
  LoggedDocument,
  UndoResult,
}

/** Commits the panel asks for. The engine caps a page at 100. */
export const CHANGELOG_LIMIT = 50

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/firestore${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // Keep the status line.
    }
    throw new ApiError(response.status, message)
  }
  return (await response.json()) as T
}

export function fetchChangeLog(database: string): Promise<ChangeLogPage> {
  return call<ChangeLogPage>(
    `/changelog?database=${encodeURIComponent(database)}&limit=${CHANGELOG_LIMIT}`,
  )
}

export function fetchCommitDiff(id: number): Promise<CommitDiff> {
  return call<CommitDiff>(`/changelog/diff?id=${id}`)
}

/**
 * What a commit did, field by field, asked for only when a row is opened.
 *
 * The engine has kept the before-images all along — the undo needs them —
 * and the panel was showing a path and a verb while the answer to "what
 * changed?" sat unread beside it. Per commit rather than with the page,
 * because two hundred commits of document data is not a list response.
 */
export const commitDiffQuery = (database: string, id: number) =>
  queryOptions({
    queryKey: [FS, database, 'changelog', 'diff', id],
    queryFn: () => fetchCommitDiff(id),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

export function undoCommit(id: number): Promise<UndoResult> {
  return call<UndoResult>('/undo', { method: 'POST', body: JSON.stringify({ id }) })
}

/**
 * The window is process-local and evaluates no rules, so the key carries no
 * authorization. The live channel invalidates it on every commit, which is
 * what keeps the list current without polling.
 */
export const changeLogQuery = (database: string) =>
  queryOptions({
    queryKey: [FS, database, 'changelog'],
    queryFn: () => fetchChangeLog(database),
    staleTime: 5_000,
    retry: false,
  })

/** `users/u_9f3k2` → `u_9f3k2`; the panel leads with the id. */
/**
 * The collection and the id, which is what names a document to a reader.
 *
 * It was the id alone, and an id alone is an opaque string: a panel row
 * read `1fcedbc4-4bb9-4333-9c68-49a089b92cd7` and left you no way to tell
 * what had been touched. The whole path is on the wire already; a
 * subcollection's ancestry is in the tooltip rather than the chip.
 */
export function documentName(path: string): string {
  const parts = path.split('/')
  return parts.slice(-2).join('/')
}

/** What pressing Undo on this commit will do, when it is worth saying. */
export function undoSays(commit: LoggedCommit): string | undefined {
  const counts = { created: 0, updated: 0, deleted: 0 }
  for (const document of commit.documents) counts[document.kind] += 1
  const total = commit.documents.length
  if (total < 2) return undefined
  const only = (['created', 'updated', 'deleted'] as const).find((kind) => counts[kind] === total)
  const verb = only === 'created' ? 'delete' : only === 'deleted' ? 'restore' : 'revert'
  return `${verb} ${total.toLocaleString('en-US')}`
}

/** One line for a commit, whatever mixture of writes it holds. */
export function describeCommit(commit: LoggedCommit): string {
  if (commit.undid !== null) return `Undid an earlier change`
  const counts = { created: 0, updated: 0, deleted: 0 }
  for (const document of commit.documents) counts[document.kind] += 1
  const parts = (['created', 'updated', 'deleted'] as const)
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind].toLocaleString('en-US')} ${kind}`)
  if (parts.length === 0) return 'No documents'
  return parts.join(', ')
}

/** Why a commit cannot be undone, or nothing when it can. */
export function undoBlockedBecause(commit: LoggedCommit): string | undefined {
  if (commit.undone) return 'Already undone'
  if (!commit.undoable) return 'Too large to keep the documents it replaced'
  return undefined
}

/**
 * Puts the most recent change back, whoever made it.
 *
 * Fetched on demand rather than kept: the palette must not hold a standing
 * query that every commit invalidates for the sake of one action nobody
 * may use. Returns what happened, so the caller can say it.
 */
export async function undoLatest(database: string): Promise<UndoResult> {
  const page = await fetchChangeLog(database)
  const latest = page.commits.find((commit) => undoBlockedBecause(commit) === undefined)
  if (!latest) throw new ApiError(404, 'There is no recent change left to undo')
  return undoCommit(latest.id)
}
