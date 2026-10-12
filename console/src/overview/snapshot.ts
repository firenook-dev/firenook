// The snapshot download as this tab follows it. Preparing one is a suite
// job every tab sees (`useSnapshot`); only the tab that pressed the button
// downloads it by itself, once it is done — every other tab, and this one
// after a reload, shows "Snapshot ready · Download" while the engine keeps
// it. The engine serves the file once, so a snapshot this tab downloaded
// is remembered and never offered again. If the tab goes away before the
// download starts, the engine is told to let the file go (best effort).

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { API_BASE, type ApiError } from '@/api/client'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { formatBytes, formatCount } from '@/lib/format'
import { serviceLabel } from '@/lib/services'
import { toast } from '@/lib/toasts'
import { type SnapshotResult, downloadSnapshot, prepareSnapshot, useSnapshot } from './api'

/** Snapshot jobs this tab started and has not downloaded yet, and the snapshots it downloaded. */
export const useSnapshotTab = create<{
  started: ReadonlySet<string>
  downloaded: ReadonlySet<string>
  start: (job: string) => void
  done: (job: string, snapshot: string) => void
}>((set) => ({
  started: new Set(),
  downloaded: new Set(),
  start: (job) => set((state) => ({ started: new Set([...state.started, job]) })),
  done: (job, snapshot) =>
    set((state) => {
      const started = new Set(state.started)
      started.delete(job)
      return { started, downloaded: new Set([...state.downloaded, snapshot]) }
    }),
}))

const FILE = { one: 'file', other: 'files' }

/** "3 files, 18.4 MB". */
export function snapshotSize(result: Pick<SnapshotResult, 'files' | 'bytes'>): string {
  return `${formatCount(result.files, FILE)}, ${formatBytes(result.bytes)}`
}

/** The services a snapshot covers on this engine, in the order the console names them. */
export const SNAPSHOT_SERVICES = ['firestore', 'auth', 'storage'] as const

/** The snapshot services this engine runs, in the console's order. */
export function snapshotServices(status: ConsoleStatus): string[] {
  return SNAPSHOT_SERVICES.filter((name) =>
    status.services.some((service) => service.name === name),
  )
}

/** "Firestore, Authentication and Storage". */
export function listedLabels(names: readonly string[]): string {
  const labels = names.map(serviceLabel)
  if (labels.length < 2) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
}

/**
 * The page's snapshot and what it can do: start one (every service this
 * engine runs, or `targets`), download the one ready, and why the last
 * start was refused.
 */
export function useSnapshotFlow(project: string) {
  const client = useQueryClient()
  const started = useSnapshotTab((state) => state.started)
  const downloaded = useSnapshotTab((state) => state.downloaded)
  const markStarted = useSnapshotTab((state) => state.start)
  const markDone = useSnapshotTab((state) => state.done)
  const snapshot = useSnapshot(project, downloaded)
  const { job, result, file } = snapshot
  const [starting, setStarting] = useState(false)
  const [refusal, setRefusal] = useState<ApiError | Error | undefined>(undefined)

  const take = async (jobId: string, ready: SnapshotResult) => {
    markDone(jobId, ready.snapshot)
    await downloadSnapshot(client, project, ready.snapshot)
    toast({
      // The job's own toast (`JobsWatch`) is replaced by the one that says what arrived.
      key: `job:${jobId}`,
      title: 'Snapshot ready',
      description: `${snapshotSize(ready)}, downloading`,
      tone: 'success',
    })
  }

  // The tab that started a snapshot downloads it as soon as the engine has it.
  const ownJob = job && started.has(job.id) ? job.id : undefined
  useEffect(() => {
    if (ownJob && result && file.data) void take(ownJob, result)
    // `take` closes over the same inputs.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ownJob, result, file.data])

  // A snapshot this tab started and has not downloaded yet goes with the tab.
  const pendingFile = ownJob && result ? result.snapshot : undefined
  const pending = useRef(pendingFile)
  useEffect(() => {
    pending.current = pendingFile
  }, [pendingFile])
  useEffect(() => {
    const discard = () => {
      const id = pending.current
      if (!id) return
      void fetchKeepalive(`${API_BASE}/overview/snapshots/${encodeURIComponent(id)}`)
    }
    window.addEventListener('pagehide', discard)
    return () => window.removeEventListener('pagehide', discard)
  }, [])

  const start = async (targets?: readonly string[]): Promise<boolean> => {
    setStarting(true)
    setRefusal(undefined)
    try {
      const prepared = await prepareSnapshot(client, targets)
      markStarted(prepared.id)
      return true
    } catch (error) {
      setRefusal(error instanceof Error ? error : new Error(String(error)))
      return false
    } finally {
      setStarting(false)
    }
  }

  const download = () => {
    if (job && result) void take(job.id, result)
  }

  return {
    ...snapshot,
    starting,
    refusal,
    clearRefusal: () => setRefusal(undefined),
    start,
    download,
    /** The newest snapshot, still kept and not downloaded by this tab. */
    ready: result && file.data && !downloaded.has(result.snapshot) ? result : undefined,
    /** The newest snapshot, downloaded by this tab. */
    taken: result && downloaded.has(result.snapshot) ? result : undefined,
  }
}

/** The page's snapshot, as `useSnapshotFlow` answers it. */
export type SnapshotFlow = ReturnType<typeof useSnapshotFlow>

/**
 * What the Data cards draw of the snapshot and can do with it: the page's
 * `SnapshotFlow`, or a fixed one (the design system draws the cards
 * without an engine). Only the file's `data` is read.
 */
export type SnapshotView = Pick<
  SnapshotFlow,
  'running' | 'job' | 'ready' | 'taken' | 'refusal' | 'starting' | 'start' | 'download'
> & { file: Pick<SnapshotFlow['file'], 'data'> }

/** `DELETE` that outlives the page (`keepalive`), with the body and header the engine's guard asks for. */
function fetchKeepalive(url: string): Promise<unknown> {
  return fetch(url, {
    method: 'DELETE',
    keepalive: true,
    headers: { 'content-type': 'application/json', 'x-firenook-console': '1' },
    body: '{}',
  }).catch(() => undefined)
}
