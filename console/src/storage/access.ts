// What the identity the page acts as may do with the files on screen, from
// a dry run of the rules in force (`POST /storage/rules/access`): nothing is
// recorded. One request per loaded page (at most 200 names each), kept
// until the rules or the objects change — the live topics invalidate
// `accessOf`. Admin bypasses the rules, so it asks nothing.
//
// The Access column reads it, and so does everything that would draw a
// file's bytes as that identity: a tile, the inspector's preview, Quick
// Look. A refused `get` draws a lock and the refusing line, never the
// picture, because an `<img>` cannot carry the identity's token and the
// media route is the operator's.

import { useQueries } from '@tanstack/react-query'
import type { StorageAccessVerdict } from '@/api/generated/storage/StorageAccessVerdict'
import type { StorageListPage } from '@/api/generated/storage/StorageListPage'
import type { ViewAs } from '@/lib/identity'
import { ACCESS_METHODS } from './api'
import { accessQuery } from './queries'

/** The most names one access check names. */
const ACCESS_BATCH = 200

/** Verdicts by object name; `undefined` while the page acts as Admin. */
export type AccessMap = ReadonlyMap<string, readonly StorageAccessVerdict[]>

/** The file names of each loaded page, in groups the access check takes. */
export function accessGroups(pages: readonly StorageListPage[]): string[][] {
  const groups: string[][] = []
  for (const page of pages) {
    const names = page.items.flatMap((entry) => (entry.type === 'file' ? [entry.name] : []))
    for (let start = 0; start < names.length; start += ACCESS_BATCH)
      groups.push(names.slice(start, start + ACCESS_BATCH))
  }
  return groups
}

export function useAccess(
  project: string,
  bucket: string,
  viewAs: ViewAs,
  pages: readonly StorageListPage[],
): AccessMap | undefined {
  const client = viewAs.kind !== 'owner'
  const groups = client ? accessGroups(pages) : []
  const answers = useQueries({
    queries: groups.map((names) => accessQuery(project, bucket, viewAs, names, ACCESS_METHODS)),
  })
  if (!client) return undefined
  const map = new Map<string, readonly StorageAccessVerdict[]>()
  for (const answer of answers)
    for (const result of answer.data?.results ?? []) map.set(result.name, result.verdicts)
  return map
}

/** One method's verdict for a name; `undefined` while it is not known yet. */
export function verdictOf(
  access: AccessMap | undefined,
  name: string,
  method: StorageAccessVerdict['method'],
): StorageAccessVerdict | undefined {
  return access?.get(name)?.find((verdict) => verdict.method === method)
}

/** Whether the identity may read the file's bytes: Admin always; a client once the check allows it. */
export function mayRead(access: AccessMap | undefined, name: string): boolean | undefined {
  if (access === undefined) return true
  const verdict = verdictOf(access, name, 'get')
  return verdict === undefined ? undefined : verdict.outcome === 'allow'
}
