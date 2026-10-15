import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/api/generated/Job'
import type { OverviewState } from '@/api/generated/observe/OverviewState'
import type { LiveChannel, TopicListener } from '@/lib/live/channel'

// The calls reach the engine through `apiGet` / `apiSend` and the browser's
// download; both are stood in for so the module's own bookkeeping is what
// is tested. The Overview's journeys exercise the real routes.
const calls = vi.hoisted(() => ({
  get: vi.fn(),
  send: vi.fn(),
  download: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  apiGet: calls.get,
  apiSend: calls.send,
}))
vi.mock('@/lib/download', () => ({ download: calls.download }))
vi.mock('@/lib/toasts', () => ({ toast: calls.toast }))

const { ApiError } = await import('@/api/client')
const { jobKey, sectionJobsKey } = await import('@/lib/jobs')
const {
  discardSnapshot,
  downloadSnapshot,
  engineQuery,
  laterJob,
  latestJob,
  overviewKeys,
  overviewQuery,
  prepareSnapshot,
  runningSuiteJob,
  saveSnapshot,
  snapshotDownloadUrl,
  snapshotFileQuery,
  snapshotResult,
  startClear,
  useOverviewLive,
} = await import('./api')
const { startSnapshot, useSnapshotTab } = await import('./snapshot')

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  calls.get.mockReset()
  calls.send.mockReset()
  calls.download.mockReset()
  calls.toast.mockReset()
})

const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'j1',
  kind: 'suite.snapshot',
  section: 'suite',
  title: 'Prepare a snapshot',
  total: 1,
  done: 0,
  skipped: 0,
  errors: [],
  errorCount: 0,
  state: 'running',
  startedAt: '2026-10-12T04:00:00.000Z',
  finishedAt: null,
  ...overrides,
})

const SNAPSHOT = '0123456789abcdef0123456789abcdef'

const state = (problems = 0): OverviewState => ({
  generatedAt: '2026-10-12T04:06:09.117Z',
  notices: [],
  problems: [],
  hour: [],
  problemsLogged: problems,
})

/** A channel that records subscriptions and lets a test speak for the engine. */
function fakeChannel() {
  const subscriptions: Array<{ topic: string; params: object; listener: TopicListener }> = []
  const channel: LiveChannel = {
    subscribe(topic, params, listener) {
      const entry = { topic, params, listener }
      subscriptions.push(entry)
      return () => {
        subscriptions.splice(subscriptions.indexOf(entry), 1)
      }
    },
    onEngineRestart: () => () => {},
    retry: () => {},
  }
  return { channel, subscriptions }
}

describe('the overview queries', () => {
  it('key everything under the section and the project', () => {
    expect(overviewQuery('demo-x').queryKey).toEqual(['overview', 'demo-x'])
    expect(engineQuery('demo-x').queryKey).toEqual(['overview', 'demo-x', 'engine'])
    expect(snapshotFileQuery('demo-x', SNAPSHOT).queryKey).toEqual([
      'overview',
      'demo-x',
      'snapshot',
      SNAPSHOT,
    ])
  })

  it('never refetch the state or the engine by themselves', () => {
    expect(overviewQuery('p').staleTime).toBe(Number.POSITIVE_INFINITY)
    expect(engineQuery('p').staleTime).toBe(Number.POSITIVE_INFINITY)
    expect(snapshotFileQuery('p', SNAPSHOT).retry).toBe(false)
  })

  it('read the routes the engine serves', async () => {
    calls.get.mockResolvedValue({})
    await client.fetchQuery(overviewQuery('p'))
    await client.fetchQuery(engineQuery('p'))
    await client.fetchQuery(snapshotFileQuery('p', SNAPSHOT))
    expect(calls.get.mock.calls.map((call) => call[0])).toEqual([
      '/overview',
      '/overview/engine',
      `/overview/snapshots/${SNAPSHOT}`,
    ])
  })
})

describe('the overview topic', () => {
  it('waits for the project, then replaces the state with every event', () => {
    const fake = fakeChannel()
    const { rerender } = renderHook(
      ({ project }: { project: string }) => useOverviewLive(project, fake.channel),
      { initialProps: { project: '' }, wrapper },
    )
    expect(fake.subscriptions).toHaveLength(0)
    rerender({ project: 'demo-x' })
    expect(fake.subscriptions.map((entry) => [entry.topic, entry.params])).toEqual([
      ['overview', {}],
    ])
    act(() => fake.subscriptions[0]?.listener.onEvent('state', state(3), '12.3'))
    expect(client.getQueryData(overviewKeys.state('demo-x'))).toEqual(state(3))
  })

  it('reloads the state on a reset, and nothing else under the section', () => {
    const fake = fakeChannel()
    client.setQueryData(overviewKeys.state('p'), state())
    client.setQueryData(overviewKeys.engine('p'), { config: null, connection: { env: [] } })
    renderHook(() => useOverviewLive('p', fake.channel), { wrapper })
    act(() => fake.subscriptions[0]?.listener.onReset('gap', null))
    expect(client.getQueryState(overviewKeys.state('p'))?.isInvalidated).toBe(true)
    expect(client.getQueryState(overviewKeys.engine('p'))?.isInvalidated).toBe(false)
  })
})

describe('snapshots', () => {
  it('read the snapshot a finished job names, and nothing else', () => {
    const done = job({
      state: 'done',
      done: 1,
      result: { snapshot: SNAPSHOT, files: 3, bytes: 18_400_000 },
    })
    expect(snapshotResult(done)).toEqual({ snapshot: SNAPSHOT, files: 3, bytes: 18_400_000 })
    expect(snapshotResult(job())).toBeUndefined()
    expect(snapshotResult({ ...done, kind: 'suite.clear' })).toBeUndefined()
    expect(
      snapshotResult({ ...done, result: { snapshot: 'j1', files: 3, bytes: 1 } }),
    ).toBeUndefined()
    expect(snapshotResult({ ...done, result: null })).toBeUndefined()
    expect(snapshotResult(undefined)).toBeUndefined()
  })

  it('find the newest snapshot job and the running data job', () => {
    const older = job({ id: 'a', state: 'done', startedAt: '2026-10-12T04:00:00.000Z' })
    const newer = job({ id: 'b', state: 'done', startedAt: '2026-10-12T04:05:00.000Z' })
    const clear = job({ id: 'c', kind: 'suite.clear', startedAt: '2026-10-12T04:06:00.000Z' })
    expect(latestJob([older, clear, newer], 'suite.snapshot')?.id).toBe('b')
    expect(latestJob([clear], 'suite.snapshot')).toBeUndefined()
    expect(runningSuiteJob([older, clear])?.id).toBe('c')
    expect(runningSuiteJob([older, newer])).toBeUndefined()
    expect(runningSuiteJob([job({ kind: 'auth.delete-users', section: 'auth' })])).toBeUndefined()
  })

  it('start as a job every view of the job reads at once', async () => {
    const started = job()
    calls.send.mockResolvedValue(started)
    await expect(prepareSnapshot(client)).resolves.toEqual(started)
    expect(calls.send).toHaveBeenCalledWith('POST', '/overview/snapshots', {})
    expect(client.getQueryData(jobKey('j1'))).toEqual(started)
    expect(client.getQueryData(sectionJobsKey('suite'))).toEqual([started])
  })

  it('start from ⌘K as this tab’s own, so it downloads here, and say a refusal', async () => {
    calls.send.mockResolvedValueOnce(job({ id: 'mine' }))
    await expect(startSnapshot(client)).resolves.toBe(true)
    expect(useSnapshotTab.getState().started.has('mine')).toBe(true)
    calls.send.mockRejectedValueOnce(
      new ApiError(409, 'Another suite action is still running.', 'conflict'),
    )
    await expect(startSnapshot(client)).resolves.toBe(false)
    expect(calls.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'The snapshot did not start',
        description: 'Another suite action is still running.',
        tone: 'danger',
      }),
    )
  })

  it('save on the engine’s machine as a job, naming services only when not all', async () => {
    const saving = job({ id: 's1', kind: 'suite.export' })
    calls.send.mockResolvedValue(saving)
    await expect(saveSnapshot(client, { destination: 'project' })).resolves.toEqual(saving)
    expect(calls.send).toHaveBeenLastCalledWith('POST', '/suite/export', {
      destination: 'project',
    })
    expect(client.getQueryData(jobKey('s1'))).toEqual(saving)
    await saveSnapshot(client, { destination: 'seed', targets: ['auth'], overwrite: true })
    expect(calls.send).toHaveBeenLastCalledWith('POST', '/suite/export', {
      destination: 'seed',
      targets: ['auth'],
      overwrite: true,
    })
  })

  it('keep the end of a short job that the topic said before the start answered', async () => {
    // The `jobs` topic delivered the end first; the POST's answer (still
    // running) must not put the job back to running for good.
    const finished = job({
      state: 'done',
      done: 1,
      result: { snapshot: SNAPSHOT, files: 3, bytes: 9 },
    })
    client.setQueryData(sectionJobsKey('suite'), [finished])
    calls.send.mockResolvedValue(job())
    await expect(prepareSnapshot(client)).resolves.toEqual(finished)
    expect(client.getQueryData(sectionJobsKey('suite'))).toEqual([finished])
    expect(client.getQueryData(jobKey('j1'))).toEqual(finished)
    expect(laterJob(job({ done: 5 }), job({ done: 2 }))).toMatchObject({ done: 5 })
    expect(laterJob(job({ done: 2 }), job({ state: 'cancelled', done: 2 }))).toMatchObject({
      state: 'cancelled',
    })
    expect(laterJob(job({ id: 'other', state: 'done' }), job())).toMatchObject({ state: 'running' })
  })

  it('download through the browser’s own download, once', async () => {
    client.setQueryData(overviewKeys.snapshot('p', SNAPSHOT), { id: SNAPSHOT })
    calls.download.mockResolvedValue(undefined)
    await downloadSnapshot(client, 'p', SNAPSHOT)
    expect(calls.download).toHaveBeenCalledWith(
      `/console/api/v1/overview/snapshots/${SNAPSHOT}/download`,
    )
    expect(snapshotDownloadUrl(SNAPSHOT)).toBe(
      `/console/api/v1/overview/snapshots/${SNAPSHOT}/download`,
    )
    expect(client.getQueryData(overviewKeys.snapshot('p', SNAPSHOT))).toBeUndefined()
  })

  it('discard one the engine keeps, and treat one already gone as discarded', async () => {
    client.setQueryData(overviewKeys.snapshot('p', SNAPSHOT), { id: SNAPSHOT })
    calls.send.mockResolvedValueOnce({})
    await discardSnapshot(client, 'p', SNAPSHOT)
    expect(calls.send).toHaveBeenCalledWith('DELETE', `/overview/snapshots/${SNAPSHOT}`, {})
    expect(client.getQueryData(overviewKeys.snapshot('p', SNAPSHOT))).toBeUndefined()
    calls.send.mockRejectedValueOnce(new ApiError(404, 'gone', 'not-found'))
    await expect(discardSnapshot(client, 'p', SNAPSHOT)).resolves.toBeUndefined()
    calls.send.mockRejectedValueOnce(new ApiError(0, 'down', 'network'))
    await expect(discardSnapshot(client, 'p', SNAPSHOT)).rejects.toThrow('down')
  })
})

describe('resets', () => {
  it('post the sections, the confirmation and the triggers only when asked', async () => {
    const started = job({ id: 'r1', kind: 'suite.clear', title: 'Clear Firestore' })
    calls.send.mockResolvedValue(started)
    await startClear(client, { sections: ['firestore'] })
    expect(calls.send).toHaveBeenLastCalledWith('POST', '/suite/clear', {
      sections: ['firestore'],
    })
    await startClear(client, {
      sections: ['firestore', 'auth'],
      confirm: 'demo-x',
      runTriggers: true,
    })
    expect(calls.send).toHaveBeenLastCalledWith('POST', '/suite/clear', {
      sections: ['firestore', 'auth'],
      confirm: 'demo-x',
      runTriggers: true,
    })
    expect(client.getQueryData(jobKey('r1'))).toEqual(started)
  })
})
