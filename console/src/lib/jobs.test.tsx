import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from './live/contract'

// The hooks read the engine through `apiGet` and the `jobs` topic; both are
// stood in for here so the hook's own bookkeeping is what is tested. The
// journeys exercise the real routes.
const calls = vi.hoisted(() => ({
  get: vi.fn(),
  send: vi.fn(),
  topics: [] as Array<{ topic: string; params: unknown; handlers: Record<string, unknown> }>,
}))

vi.mock('@/api/client', () => ({
  apiGet: calls.get,
  apiSend: calls.send,
}))

vi.mock('@/lib/live/use-live-topic', () => ({
  useLiveTopic: (topic: string, params: unknown, handlers: Record<string, unknown>) => {
    calls.topics.push({ topic, params, handlers })
    return 'live'
  },
}))

const { cancelJob, mergeJob, useJob, useJobs } = await import('./jobs')
const { queryClient: pageClient } = await import('./query')

/** The `onJob` handler the hook gave the topic last. */
function onJob(): (job: Job) => void {
  const subscription = calls.topics.at(-1)
  if (!subscription) throw new Error('the hook subscribed to nothing')
  return subscription.handlers.onJob as (job: Job) => void
}

const job = (id: string, done: number, state: Job['state'] = 'running'): Job => ({
  id,
  kind: 'suite.clear',
  section: 'suite',
  title: 'Reset Firestore',
  total: 100,
  done,
  skipped: 0,
  errors: [],
  errorCount: 0,
  state,
  startedAt: '2026-10-12T00:00:00Z',
  finishedAt: state === 'running' ? null : '2026-10-12T00:00:05Z',
})

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  calls.get.mockReset()
  calls.send.mockReset()
  calls.topics.length = 0
})

describe('jobs', () => {
  it('merges a job into a list in its place, or first when it is new', () => {
    const list = [job('j2', 10), job('j1', 100, 'done')]
    expect(mergeJob(list, job('j1', 100, 'failed')).map((item) => item.state)).toEqual([
      'running',
      'failed',
    ])
    expect(mergeJob(list, job('j3', 0)).map((item) => item.id)).toEqual(['j3', 'j2', 'j1'])
  })

  it('re-attaches to a section’s jobs and follows them on the topic', async () => {
    calls.get.mockResolvedValue({ jobs: [job('j1', 10)] })
    const { result } = renderHook(() => useJobs('suite'), { wrapper })
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(calls.get).toHaveBeenCalledWith('/jobs', { section: 'suite' }, expect.anything())
    const subscription = calls.topics.at(-1)
    expect(subscription).toMatchObject({ topic: 'jobs', params: { section: 'suite' } })
    act(() => onJob()(job('j1', 60)))
    await waitFor(() => expect(result.current[0]?.done).toBe(60))
    act(() => onJob()(job('j2', 0)))
    await waitFor(() => expect(result.current.map((item) => item.id)).toEqual(['j2', 'j1']))
    expect(client.getQueryData(['jobs', 'j2'])).toMatchObject({ id: 'j2' })
  })

  it('reads one job and subscribes to its section once it is known', async () => {
    calls.get.mockResolvedValue(job('j1', 5))
    const { result } = renderHook(() => useJob('j1'), { wrapper })
    await waitFor(() => expect(result.current?.done).toBe(5))
    expect(calls.get).toHaveBeenCalledWith('/jobs/j1', {}, expect.anything())
    const subscription = calls.topics.at(-1)
    expect(subscription).toMatchObject({ topic: 'jobs', params: { section: 'suite' } })
    act(() => onJob()(job('other', 1)))
    act(() => onJob()(job('j1', 100, 'done')))
    await waitFor(() => expect(result.current?.state).toBe('done'))
  })

  it('cancels through the engine and keeps the answer', async () => {
    calls.send.mockResolvedValue(job('j1', 40, 'cancelled'))
    const answer = await cancelJob('j1')
    expect(calls.send).toHaveBeenCalledWith('POST', '/jobs/j1/cancel', {})
    expect(answer.state).toBe('cancelled')
    expect(pageClient.getQueryData(['jobs', 'j1'])).toMatchObject({ state: 'cancelled' })
  })
})
