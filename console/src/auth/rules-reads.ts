// Where the rules read each custom claim: the rules engine's own analysis
// (`Ruleset::claim_reads()`), carried as `claimReads` on the rules documents
// — every spelling (`request.auth.token.role`, `token['role']`,
// `token.get('role', '')`, `'role' in request.auth.token`, a `let` or a
// parameter bound to the token), never a pattern over the text. A read
// whose key is computed at run time is listed once as such, so "not read
// by any rules" is never said while a dynamic read could reach the key.
//
// Firestore's documents come from `GET /firestore/rules?database=` for
// each database (shared with the Firestore rules page's cache); Storage's
// from `GET /storage/rules?bucket=` for each bucket, once the Storage
// section is built and serves them.

import { queryOptions, useQueries, useQuery } from '@tanstack/react-query'
import { apiGet } from '@/api/client'
import type { DatabaseList } from '@/api/generated/DatabaseList'
import type { RulesClaimRead } from '@/api/generated/RulesClaimRead'
import type { RulesDocument } from '@/api/generated/RulesDocument'
import { statusQuery } from '@/api/queries'
import { storage } from '@/lib/sections/storage'
import type { RulesTarget } from './links'

/** Where one ruleset is, as its rules page names it. */
export interface RulesSource {
  target: RulesTarget
  /** "Firestore (default)", "Storage demo.appspot.com". */
  label: string
  reads: readonly RulesClaimRead[]
}

/** Where one claim is read: a ruleset and its lines. */
export interface ClaimReadPlace {
  target: RulesTarget
  label: string
  lines: number[]
}

export interface ClaimReadsByKey {
  /** Each key read by name, with every ruleset that reads it. */
  byKey: Map<string, ClaimReadPlace[]>
  /** Reads whose key is chosen at run time (`token[k]`): any key may be one of them. */
  dynamic: { target: RulesTarget; label: string; line: number; form: RulesClaimRead['form'] }[]
}

/** The reads of every ruleset, by claim key; lines in order, each once. */
export function groupClaimReads(sources: readonly RulesSource[]): ClaimReadsByKey {
  const byKey = new Map<string, ClaimReadPlace[]>()
  const dynamic: ClaimReadsByKey['dynamic'] = []
  for (const source of sources)
    for (const read of source.reads) {
      if (read.key === null) {
        dynamic.push({
          target: source.target,
          label: source.label,
          line: read.line,
          form: read.form,
        })
        continue
      }
      const places = byKey.get(read.key) ?? []
      let place = places.find((candidate) => candidate.label === source.label)
      if (!place) {
        place = { target: source.target, label: source.label, lines: [] }
        places.push(place)
      }
      if (!place.lines.includes(read.line)) place.lines.push(read.line)
      place.lines.sort((a, b) => a - b)
      byKey.set(read.key, places)
    }
  return { byKey, dynamic }
}

const databasesQuery = queryOptions({
  queryKey: ['databases'],
  queryFn: ({ signal }) => apiGet<DatabaseList>('/firestore/databases', undefined, signal),
  retry: false,
})

/** The Firestore rules page's own cache entry, so both read one answer. */
const firestoreRulesQuery = (database: string) =>
  queryOptions({
    queryKey: ['fs', database, 'rules'],
    queryFn: ({ signal }) => apiGet<RulesDocument>('/firestore/rules', { database }, signal),
    retry: false,
    // Read again each time the claims tab opens: a rules file may have changed since.
    staleTime: 0,
  })

interface StorageBucketList {
  buckets: { name: string }[]
}
interface StorageRules {
  bucket: string | null
  claimReads: RulesClaimRead[] | null
}

/**
 * Every ruleset's claim reads while its service runs: Firestore's databases,
 * and Storage's buckets once the Storage section is built. Read when the
 * claims tab is open, refreshed whenever it opens again.
 */
export function useClaimReadSources(enabled: boolean): {
  sources: RulesSource[]
  firestore: boolean
  storage: boolean
} {
  const status = useQuery(statusQuery)
  const runs = (name: string) =>
    status.data?.services.some((service) => service.name === name) === true
  const firestore = enabled && runs('firestore')
  const storageOn = enabled && runs('storage') && storage.built
  const databases = useQuery({ ...databasesQuery, enabled: firestore })
  const buckets = useQuery({
    queryKey: ['storage', 'claim-read-buckets'],
    queryFn: ({ signal }) => apiGet<StorageBucketList>('/storage/buckets', undefined, signal),
    enabled: storageOn,
    retry: false,
  })
  const firestoreDocs = useQueries({
    queries: (firestore ? (databases.data?.databases ?? []) : []).map((database) =>
      firestoreRulesQuery(database.id),
    ),
  })
  const storageDocs = useQueries({
    queries: (storageOn ? (buckets.data?.buckets ?? []) : []).map((bucket) => ({
      queryKey: ['storage', 'claim-reads', bucket.name],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiGet<StorageRules>('/storage/rules', { bucket: bucket.name }, signal),
      retry: false,
      staleTime: 0,
    })),
  })
  const sources: RulesSource[] = []
  for (const result of firestoreDocs) {
    const document = result.data
    if (!document) continue
    sources.push({
      target: { service: 'firestore', database: document.database },
      label: `Firestore ${document.database}`,
      reads: document.claimReads,
    })
  }
  storageDocs.forEach((result, index) => {
    const bucket = buckets.data?.buckets[index]?.name
    if (!result.data || !bucket) return
    sources.push({
      target: { service: 'storage', bucket },
      label: `Storage ${bucket}`,
      reads: result.data.claimReads ?? [],
    })
  })
  return { sources, firestore, storage: storageOn }
}
