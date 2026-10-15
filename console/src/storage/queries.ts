// Storage's TanStack Query keys and options, for every Storage page.
//
// Keys are the foundation's shape, `[section, project, scope…, kind, …]`:
// `'storage'`, the configured project (buckets are not per project, but the
// project keeps one engine's data apart from another's), then the bucket,
// so the live topics invalidate by prefix — a `reset` of `storage.objects`
// resets `['storage', p, bucket]` and with it every list, folder and object
// of that bucket. The rules' keys take the rules scope instead of the bucket:
// the bucket in per-bucket mode, `'*'` when one ruleset governs every bucket.
// A query that reads as an identity puts `identityKey(viewAs)` in its key,
// never a token.

import { type QueryKey, queryOptions } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import type { BatchGetRequest } from '@/api/generated/BatchGetRequest'
import type { BatchGetResponse } from '@/api/generated/BatchGetResponse'
import type { RulesMethod } from '@/api/generated/RulesMethod'
import type { StorageBuckets } from '@/api/generated/storage/StorageBuckets'
import type { StorageDecisionsParams } from '@/api/generated/storage/StorageDecisionsParams'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import type { StorageListPage } from '@/api/generated/storage/StorageListPage'
import type { StorageRulesDocument } from '@/api/generated/storage/StorageRulesDocument'
import { type CursorPageParam, cursorPagesOptions } from '@/components/console/use-cursor-rows'
import {
  OWNER_AUTHORIZATION,
  type ViewAs,
  forgetToken,
  identityKey,
  resolveAuthorization,
} from '@/lib/identity'
import { coverageQueryOptions } from '@/rules/coverage'
import type { RulesBackend } from '@/rules/draft'
import {
  type StorageListScope,
  batchGetObjects,
  checkRules,
  coverageUrl,
  getAccess,
  getActivity,
  getBuckets,
  getDecision,
  getDecisions,
  getEventPayloads,
  getFolder,
  getImpact,
  getObject,
  getObjectsMeta,
  getProfile,
  getRules,
  getRulesHistory,
  listObjects,
  putRules,
} from './api'

/** Storage's section id: the first element of every Storage key. */
export const ST = 'storage'

/** The rules scope when one ruleset governs every bucket. */
export const ALL_BUCKETS = '*'

/** How long the folder profile (starter rules, completions) is kept fresh. */
const PROFILE_STALE_MS = 60_000
/** How long an impact answer is kept: the decisions it re-runs move on. */
const IMPACT_STALE_MS = 5_000

const FOREVER = Number.POSITIVE_INFINITY

/** Everything a listing's key holds besides the bucket and the folder. */
export interface StorageListView {
  flat: boolean
  kind: StorageListScope['kind']
  sort: string | undefined
  q: string | undefined
  /** `identityKey(viewAs)`. */
  as: string
}

export const storageKeys = {
  /** Every Storage query of a project. */
  all: (project: string) => [ST, project] as const,
  buckets: (project: string) => [ST, project, 'buckets'] as const,
  objectsMeta: (project: string) => [ST, project, 'objects-meta'] as const,
  /** Every query of one bucket: what a `reset` of its live topic starts again. */
  bucket: (project: string, bucket: string) => [ST, project, bucket] as const,
  /** Every listing of a bucket. */
  objectsOf: (project: string, bucket: string) => [ST, project, bucket, 'objects'] as const,
  /** Every listing of one folder, whatever its view. */
  objectsAt: (project: string, bucket: string, prefix: string) =>
    [ST, project, bucket, 'objects', prefix] as const,
  objects: (project: string, bucket: string, prefix: string, view: StorageListView) =>
    [ST, project, bucket, 'objects', prefix, view] as const,
  foldersOf: (project: string, bucket: string) => [ST, project, bucket, 'folder'] as const,
  /** Every node of the panel's folder tree. */
  treeOf: (project: string, bucket: string) => [ST, project, bucket, 'tree'] as const,
  /** The folders directly under `prefix`, as the tree shows them (the first 100). */
  tree: (project: string, bucket: string, prefix: string) =>
    [ST, project, bucket, 'tree', prefix] as const,
  folder: (project: string, bucket: string, prefix: string) =>
    [ST, project, bucket, 'folder', prefix] as const,
  /** An object as any identity reads it. */
  objectAnyone: (project: string, bucket: string, name: string) =>
    [ST, project, bucket, 'object', name] as const,
  object: (project: string, bucket: string, name: string, as: string) =>
    [ST, project, bucket, 'object', name, as] as const,
  activity: (project: string, bucket: string, name: string) =>
    [ST, project, bucket, 'activity', name] as const,
  /** An object's event payloads, any generation. */
  eventsOf: (project: string, bucket: string, name: string) =>
    [ST, project, bucket, 'events', name] as const,
  events: (project: string, bucket: string, name: string, generation: string) =>
    [ST, project, bucket, 'events', name, generation] as const,
  profilesOf: (project: string, bucket: string) => [ST, project, bucket, 'profile'] as const,
  profile: (project: string, bucket: string, prefix: string) =>
    [ST, project, bucket, 'profile', prefix] as const,
  /** Every access check of a bucket. */
  accessOf: (project: string, bucket: string) => [ST, project, bucket, 'access'] as const,
  access: (project: string, bucket: string, as: string, names: readonly string[]) =>
    [ST, project, bucket, 'access', as, [...names]] as const,
  rules: (project: string, scope: string) => [ST, project, scope, 'rules'] as const,
  rulesCheck: (project: string, scope: string, source: string) =>
    [ST, project, scope, 'rules-check', source] as const,
  rulesHistory: (project: string, scope: string) => [ST, project, scope, 'rules-history'] as const,
  rulesCoverage: (project: string, scope: string) =>
    [ST, project, scope, 'rules-coverage'] as const,
  /** Every impact answer of a scope, whatever the draft. */
  rulesImpactOf: (project: string, scope: string) => [ST, project, scope, 'rules-impact'] as const,
  rulesImpact: (project: string, scope: string, source: string) =>
    [ST, project, scope, 'rules-impact', source] as const,
  rulesDecision: (project: string, scope: string, id: string) =>
    [ST, project, scope, 'rules-decision', id] as const,
  rulesDecisions: (project: string, params: StorageDecisionsParams) =>
    [ST, project, 'rules-decisions', params] as const,
} satisfies Record<string, (...args: never[]) => QueryKey>

/** The rules scope of a bucket: the bucket itself in per-bucket mode, `'*'` otherwise. */
export function rulesScope(
  buckets: Pick<StorageBuckets, 'rulesMode'> | undefined,
  bucket: string,
): string {
  return buckets?.rulesMode === 'perBucket' ? bucket : ALL_BUCKETS
}

/** The `bucket` a rules call names for a scope: none for the one scope of every bucket. */
export function scopeBucket(scope: string): string | undefined {
  return scope === ALL_BUCKETS ? undefined : scope
}

/**
 * A call made as `viewAs`: the `Authorization` it sends, and once more with a
 * token minted again when the engine refused the first as expired (401).
 */
export async function asIdentity<T>(
  viewAs: ViewAs,
  project: string,
  send: (authorization: string | undefined) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await send(await resolveAuthorization(viewAs, project, signal))
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !forgetToken(viewAs, project))
      throw error
    return send(await resolveAuthorization(viewAs, project, signal))
  }
}

// ---------------------------------------------------------------------------
// Buckets, listings, folders, objects.

export const bucketsQuery = (project: string) =>
  queryOptions({
    queryKey: storageKeys.buckets(project),
    queryFn: ({ signal }) => getBuckets(signal),
    staleTime: FOREVER,
  })

export const objectsMetaQuery = (project: string) =>
  queryOptions({
    queryKey: storageKeys.objectsMeta(project),
    queryFn: ({ signal }) => getObjectsMeta(signal),
    staleTime: FOREVER,
  })

/** The row key of a listing entry: a folder's prefix (ending in `/`) or a file's name. */
export function entryKey(entry: StorageEntry): string {
  return entry.type === 'folder' ? entry.prefix : entry.name
}

/** Listings (by query key) whose next first page is read fresh. */
const freshFirstPages = new Set<string>()

/**
 * The next first page of this listing is read fresh, once: the engine
 * rebuilds a sorted or filtered view the app's writes have moved instead of
 * serving it, marked stale, for up to 2 s (what Refresh wants).
 */
export function readFreshNext(queryKey: QueryKey): void {
  freshFirstPages.add(JSON.stringify(queryKey))
}

/**
 * A listing as `useCursorRows` takes it: the key, the infinite query's
 * options (a sliding window of 20 pages), the page fetcher, and the batch
 * read that patches the rows a live event names.
 */
export function objectsList(project: string, scope: StorageListScope, viewAs: ViewAs) {
  const view: StorageListView = {
    flat: scope.flat ?? false,
    kind: scope.kind ?? 'all',
    sort: scope.sort,
    q: scope.q?.trim() ? scope.q : undefined,
    as: identityKey(viewAs),
  }
  const queryKey = storageKeys.objects(project, scope.bucket, scope.prefix, view)
  const fetchPage = (page: CursorPageParam, signal: AbortSignal): Promise<StorageListPage> => {
    const first = page.cursor === undefined && page.before === undefined
    const fresh = first && freshFirstPages.delete(JSON.stringify(queryKey))
    return asIdentity(
      viewAs,
      project,
      (authorization) => listObjects(scope, { ...page, fresh }, { authorization, signal }),
      signal,
    )
  }
  const batchGet = (
    request: BatchGetRequest,
    signal: AbortSignal,
  ): Promise<BatchGetResponse<StorageEntry>> =>
    asIdentity(
      viewAs,
      project,
      (authorization) =>
        batchGetObjects(
          {
            ...request,
            bucket: scope.bucket,
            prefix: scope.prefix,
            flat: view.flat,
            kind: view.kind ?? 'all',
          },
          { authorization, signal },
        ),
      signal,
    )
  return {
    queryKey,
    fetchPage,
    batchGet,
    rowKey: entryKey,
    options: {
      ...cursorPagesOptions<StorageEntry>(queryKey, fetchPage),
      staleTime: FOREVER,
    },
  }
}

/** How many folders a tree node shows before it offers the rest in the list. */
export const TREE_LIMIT = 100

/**
 * The folders directly under `prefix`, the first 100 by name: one node of
 * the panel's tree. The tree is the bucket's map, read as the operator
 * whoever the page acts as — its figures are the folder index's, which no
 * rule governs — while the listing beside it meets the rules.
 */
export const treeQuery = (project: string, bucket: string, prefix: string) =>
  queryOptions({
    queryKey: storageKeys.tree(project, bucket, prefix),
    queryFn: ({ signal }) =>
      listObjects(
        { bucket, prefix, kind: 'folders' },
        { limit: TREE_LIMIT },
        { authorization: OWNER_AUTHORIZATION, signal },
      ),
    staleTime: FOREVER,
  })

export const folderQuery = (project: string, bucket: string, prefix: string) =>
  queryOptions({
    queryKey: storageKeys.folder(project, bucket, prefix),
    queryFn: ({ signal }) => getFolder(bucket, prefix, signal),
    staleTime: FOREVER,
  })

export const profileQuery = (project: string, bucket: string, prefix: string) =>
  queryOptions({
    queryKey: storageKeys.profile(project, bucket, prefix),
    queryFn: ({ signal }) => getProfile(bucket, prefix, signal),
    staleTime: PROFILE_STALE_MS,
  })

export const objectQuery = (project: string, bucket: string, name: string, viewAs: ViewAs) =>
  queryOptions({
    queryKey: storageKeys.object(project, bucket, name, identityKey(viewAs)),
    queryFn: ({ signal }) =>
      asIdentity(
        viewAs,
        project,
        (authorization) => getObject(bucket, name, { authorization, signal }),
        signal,
      ),
    staleTime: FOREVER,
    // A refusal or a missing object is an answer, not a blip to retry.
    retry: false,
  })

export const activityQuery = (project: string, bucket: string, name: string) =>
  queryOptions({
    queryKey: storageKeys.activity(project, bucket, name),
    queryFn: ({ signal }) => getActivity(bucket, name, signal),
    staleTime: FOREVER,
  })

export const eventsQuery = (project: string, bucket: string, name: string, generation: string) =>
  queryOptions({
    queryKey: storageKeys.events(project, bucket, name, generation),
    queryFn: ({ signal }) => getEventPayloads(bucket, name, signal),
    staleTime: FOREVER,
  })

/**
 * What `viewAs` may do with each of `names` (≤ 200), from a dry run against
 * the rules in force: nothing is recorded. Kept until the rules or the
 * objects change (the live topics invalidate `accessOf`).
 */
export const accessQuery = (
  project: string,
  bucket: string,
  viewAs: ViewAs,
  names: readonly string[],
  methods: readonly RulesMethod[],
) =>
  queryOptions({
    queryKey: storageKeys.access(project, bucket, identityKey(viewAs), names),
    queryFn: async ({ signal }) => {
      const authorization = await resolveAuthorization(viewAs, project, signal)
      return getAccess(
        { bucket, authorization: authorization ?? null, names: [...names], methods: [...methods] },
        signal,
      )
    },
    staleTime: FOREVER,
    enabled: names.length > 0,
  })

// ---------------------------------------------------------------------------
// Rules.

export const storageRulesQuery = (project: string, scope: string) =>
  queryOptions({
    queryKey: storageKeys.rules(project, scope),
    queryFn: ({ signal }): Promise<StorageRulesDocument> => getRules(scopeBucket(scope), signal),
    staleTime: FOREVER,
    retry: false,
  })

export const storageRulesCheckQuery = (project: string, scope: string, source: string) =>
  queryOptions({
    queryKey: storageKeys.rulesCheck(project, scope, source),
    queryFn: ({ signal }) => checkRules({ ...withBucket(scope), source }, signal),
    staleTime: FOREVER,
    retry: false,
  })

export const storageRulesHistoryQuery = (project: string, scope: string) =>
  queryOptions({
    queryKey: storageKeys.rulesHistory(project, scope),
    queryFn: ({ signal }) => getRulesHistory(scopeBucket(scope), signal),
    staleTime: FOREVER,
    retry: false,
  })

/** How often each expression ran: the official report the rules kit draws (null with nothing to count). */
export const storageCoverageQuery = (project: string, scope: string) =>
  coverageQueryOptions(storageKeys.rulesCoverage(project, scope), coverageUrl(scopeBucket(scope)))

export const storageImpactQuery = (project: string, scope: string, source: string) =>
  queryOptions({
    queryKey: storageKeys.rulesImpact(project, scope, source),
    queryFn: ({ signal }) => getImpact({ ...withBucket(scope), source }, signal),
    staleTime: IMPACT_STALE_MS,
    retry: false,
  })

/** A decision run again with its values; `null` once the engine no longer keeps its request. */
export const storageDecisionQuery = (project: string, scope: string, id: string) =>
  queryOptions({
    queryKey: storageKeys.rulesDecision(project, scope, id),
    queryFn: ({ signal }) => getDecision(id, signal),
    staleTime: FOREVER,
    retry: false,
  })

/** The decisions the engine holds for the topic's parameters: the panel's first paint. */
export const storageDecisionsQuery = (project: string, params: StorageDecisionsParams) =>
  queryOptions({
    queryKey: storageKeys.rulesDecisions(project, params),
    queryFn: ({ signal }) => getDecisions(params, signal),
    staleTime: FOREVER,
    retry: false,
  })

function withBucket(scope: string): { bucket?: string } {
  const bucket = scopeBucket(scope)
  return bucket === undefined ? {} : { bucket }
}

/**
 * A scope's rules as the rules kit's draft reaches them: the document in
 * force, installing a text (and saving it with `save`), and where this tab
 * keeps the draft.
 */
export function storageRulesBackend(project: string, scope: string) {
  return {
    draftKey: `firenook.console.storage-rules-draft.${project}.${scope}`,
    document: storageRulesQuery(project, scope),
    put: (source: string, save: boolean) =>
      putRules({ ...withBucket(scope), source, save }).then((installed) => ({
        saved: installed.saved,
        path: installed.path,
      })),
  } satisfies RulesBackend<StorageRulesDocument, ReturnType<typeof storageKeys.rules>>
}
