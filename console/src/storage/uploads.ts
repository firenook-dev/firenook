// The tab's uploads: real uploads through the engine's commit path, as the
// identity the page acts as — they meet the rules, mint a token and fire
// the triggers an SDK upload would. Each file streams in one `PUT` with its
// progress (an XHR), taking a slot of the tab's long-request pool, so at
// most three go at once and pictures still get through; a client identity's
// drop is dry-run first (one `POST /storage/rules/evaluate` per 200 files)
// so refused files never send a byte. Cancel aborts the request and the
// engine drops the staged bytes; a failed file can be sent again. The queue
// lives as long as the tab, so it survives moving around the console.

import { ApiError } from '@/api/client'
import type { StorageEvaluateRequest } from '@/api/generated/storage/StorageEvaluateRequest'
import { type ViewAs, resolveAuthorization } from '@/lib/identity'
import {
  StorageApiError,
  type StorageUploadMetadata,
  type StorageUploadSpec,
  type UploadTransport,
  evaluateRules,
  objectsExist,
  uploadObject,
} from './api'
import { storagePool } from './net'
import { asIdentity } from './queries'
import { type UploadItem, isActive, useUploadQueue } from './upload-queue-store'

/** How often one file's progress reaches the store, at most. */
export const PROGRESS_MS = 100
/** Names one existence check asks about. */
const EXISTS_BATCH = 1_000
/** Requests one dry run judges. */
const EVALUATE_BATCH = 200

/** One file to send. */
export interface UploadPlan {
  file: Blob
  /** The object name it becomes. */
  name: string
  size: number
  contentType: string | undefined
  metadata: StorageUploadMetadata
}

/** Where a drop goes and as whom. */
export interface UploadContext {
  bucket: string
  project: string
  viewAs: ViewAs
}

/** What sends an upload's request: the browser's XHR; a test stands in for it. */
let transport: (() => UploadTransport) | undefined

/** Tests only: send uploads through `factory` instead of the browser's XHR (`undefined` restores it). */
export function setUploadTransport(factory: (() => UploadTransport) | undefined): void {
  transport = factory
}

interface Work {
  plan: UploadPlan
  context: UploadContext
  controller: AbortController | undefined
}

/** The bytes and the request behind each queued item; the store keeps only data. */
const work = new Map<string, Work>()
let nextId = 0

/**
 * `a (1).png`, `a (2).png`: the first name not taken, as "Keep both" names
 * the new file. The extension stays (`Makefile (1)`, `.env (1)` have none).
 */
export function keepBothName(name: string, taken: ReadonlySet<string>): string {
  const slash = name.lastIndexOf('/')
  const folder = name.slice(0, slash + 1)
  const base = name.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const extension = dot > 0 ? base.slice(dot) : ''
  for (let index = 1; ; index += 1) {
    const candidate = `${folder}${stem} (${index})${extension}`
    if (!taken.has(candidate)) return candidate
  }
}

/** What to do with a name that is taken. */
export type ConflictChoice = 'replace' | 'skip' | 'keep'

/** The drop as it will be sent: taken names replaced, skipped or renamed. */
export function resolveConflicts(
  plans: readonly UploadPlan[],
  existing: ReadonlySet<string>,
  choice: ConflictChoice,
): { send: UploadPlan[]; skipped: UploadPlan[] } {
  const taken = new Set(existing)
  for (const plan of plans) taken.add(plan.name)
  const send: UploadPlan[] = []
  const skipped: UploadPlan[] = []
  for (const plan of plans) {
    if (!existing.has(plan.name) || choice === 'replace') {
      send.push(plan)
      continue
    }
    if (choice === 'skip') {
      skipped.push(plan)
      continue
    }
    const renamed = keepBothName(plan.name, taken)
    taken.add(renamed)
    send.push({ ...plan, name: renamed })
  }
  return { send, skipped }
}

/** Which of `names` exist in the bucket, asked a thousand at a time. */
export async function existingNames(
  bucket: string,
  names: readonly string[],
): Promise<Set<string>> {
  const batches: string[][] = []
  for (let from = 0; from < names.length; from += EXISTS_BATCH)
    batches.push(names.slice(from, from + EXISTS_BATCH))
  const answers = await Promise.all(batches.map((batch) => objectsExist({ bucket, names: batch })))
  return new Set(answers.flatMap((answer) => answer.existing))
}

/** The `create` request the rules would judge for a planned upload. */
export function createRequest(
  plan: UploadPlan,
  bucket: string,
  authorization: string | undefined,
): StorageEvaluateRequest {
  return {
    method: 'create',
    bucket,
    path: plan.name,
    authorization: authorization ?? null,
    proposed: {
      size: plan.size,
      contentType: plan.contentType ?? null,
      ...(plan.metadata.cacheControl ? { cacheControl: plan.metadata.cacheControl } : {}),
      ...(plan.metadata.contentDisposition
        ? { contentDisposition: plan.metadata.contentDisposition }
        : {}),
      ...(plan.metadata.customMetadata ? { customMetadata: plan.metadata.customMetadata } : {}),
    },
  }
}

const patch = (id: string, change: Partial<UploadItem>) =>
  useUploadQueue.getState().patch(id, change)

/**
 * Queues a drop: each plan becomes a tray row; a client identity's are
 * judged first and refused ones end there; the rest start, three at a time.
 */
export async function enqueueUploads(
  plans: readonly UploadPlan[],
  context: UploadContext,
  skipped: readonly UploadPlan[] = [],
): Promise<void> {
  const client = context.viewAs.kind !== 'owner'
  const items: UploadItem[] = []
  const ids: string[] = []
  for (const plan of plans) {
    nextId += 1
    const id = `upload-${nextId}`
    ids.push(id)
    work.set(id, { plan, context, controller: undefined })
    items.push({
      id,
      bucket: context.bucket,
      name: plan.name,
      size: plan.size,
      loaded: 0,
      state: client ? 'checking' : 'queued',
    })
  }
  for (const plan of skipped) {
    nextId += 1
    items.push({
      id: `upload-${nextId}`,
      bucket: context.bucket,
      name: plan.name,
      size: plan.size,
      loaded: 0,
      state: 'skipped',
      message: 'Already exists — skipped',
    })
  }
  useUploadQueue.getState().add(items)
  if (client) {
    const allowed = await dryRun(ids, context)
    for (const id of allowed) start(id)
    return
  }
  for (const id of ids) start(id)
}

/** Judges the queued uploads as the identity; refused ones end, answers the ids allowed. */
async function dryRun(ids: readonly string[], context: UploadContext): Promise<string[]> {
  let authorization: string | undefined
  try {
    authorization = await resolveAuthorization(context.viewAs, context.project)
  } catch (error) {
    for (const id of ids)
      patch(id, {
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    return []
  }
  const allowed: string[] = []
  const batches: string[][] = []
  for (let from = 0; from < ids.length; from += EVALUATE_BATCH)
    batches.push(ids.slice(from, from + EVALUATE_BATCH))
  await Promise.all(
    batches.map(async (batch) => {
      const requests = batch.flatMap((id) => {
        const item = work.get(id)
        return item ? [createRequest(item.plan, context.bucket, authorization)] : []
      })
      try {
        const answer = await evaluateRules({ bucket: context.bucket, requests })
        batch.forEach((id, index) => {
          const result = answer.results[index]
          if (!result || result.outcome === 'allow') {
            allowed.push(id)
            return
          }
          const line = result.allows.find((allow) => allow.outcome !== 'allow')?.line ?? null
          work.delete(id)
          patch(id, {
            state: 'refused',
            notSent: true,
            line,
            message:
              line === null
                ? 'Refused: no allow matched — not sent'
                : `Refused by line ${line} — not sent`,
            refusal: { evaluation: result, line, request: requests[index] ?? null },
          })
        })
      } catch {
        // The dry run is a courtesy: when it cannot run, the upload meets the rules itself.
        allowed.push(...batch)
      }
    }),
  )
  return allowed
}

/** Sends one queued upload when its slot comes. */
function start(id: string): void {
  const item = work.get(id)
  if (!item) return
  const controller = new AbortController()
  item.controller = controller
  patch(id, { state: 'queued', loaded: 0, message: undefined })
  void storagePool
    .acquire('upload', { signal: controller.signal })
    .then(async (release) => {
      patch(id, { state: 'uploading' })
      let last = 0
      const { plan, context } = item
      const spec: Omit<StorageUploadSpec, 'authorization'> = {
        bucket: context.bucket,
        name: plan.name,
        contentType: plan.contentType,
        metadata: plan.metadata,
      }
      try {
        await asIdentity(context.viewAs, context.project, (authorization) =>
          uploadObject(
            plan.file,
            { ...spec, authorization },
            {
              signal: controller.signal,
              ...(transport ? { transport } : {}),
              onProgress: (loaded) => {
                const now = Date.now()
                if (now - last < PROGRESS_MS && loaded < plan.size) return
                last = now
                patch(id, { loaded })
              },
            },
          ),
        )
        work.delete(id)
        patch(id, { state: 'done', loaded: plan.size })
      } catch (error) {
        settle(id, error)
      } finally {
        release()
      }
    })
    .catch((error: unknown) => settle(id, error))
}

/** What a failed upload's row says. */
export function failureOf(error: unknown): Partial<UploadItem> {
  if (error instanceof DOMException && error.name === 'AbortError')
    return { state: 'cancelled', message: 'Cancelled' }
  if (error instanceof StorageApiError && error.refused) {
    const line = error.extras.line ?? null
    return {
      state: 'refused',
      line,
      message: line === null ? 'Refused: no allow matched' : `Refused by line ${line}`,
      refusal: error.extras,
    }
  }
  if (error instanceof ApiError && error.code === 'already-exists')
    return { state: 'skipped', message: 'Already exists — skipped' }
  return { state: 'failed', message: error instanceof Error ? error.message : String(error) }
}

function settle(id: string, error: unknown): void {
  const outcome = failureOf(error)
  // A refused upload stays refused; a cancelled one can be sent again.
  if (outcome.state === 'refused' || outcome.state === 'skipped') work.delete(id)
  patch(id, outcome)
}

export function cancelUpload(id: string): void {
  const item = work.get(id)
  if (!item) return
  if (item.controller) item.controller.abort()
  else patch(id, { state: 'cancelled', message: 'Cancelled' })
}

export function cancelAllUploads(): void {
  for (const item of useUploadQueue.getState().items) if (isActive(item)) cancelUpload(item.id)
}

/** Sends a failed or cancelled upload again; its bytes are still here. */
export function retryUpload(id: string): void {
  if (work.has(id)) start(id)
}

export function retryFailedUploads(): void {
  for (const item of useUploadQueue.getState().items)
    if ((item.state === 'failed' || item.state === 'cancelled') && work.has(item.id)) start(item.id)
}

/** Whether an item can be sent again (its bytes are still held). */
export function canRetry(id: string): boolean {
  return work.has(id)
}

/** Forgets every finished upload's bytes and rows (the tray's Clear). */
export function clearFinishedUploads(): void {
  for (const item of useUploadQueue.getState().items) if (!isActive(item)) work.delete(item.id)
  useUploadQueue.getState().clearFinished()
}
