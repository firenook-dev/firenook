import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from '@cloudflare/kumo'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/api/generated/Job'

// The section's jobs come from `GET /jobs?section=` and the `jobs` topic;
// both are stood in for, so what is tested is what the banners say.
const calls = vi.hoisted(() => ({
  get: vi.fn(),
  send: vi.fn(),
  onJob: undefined as ((job: Job) => void) | undefined,
}))

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  apiGet: calls.get,
  apiSend: calls.send,
}))

vi.mock('@/lib/live/use-live-topic', () => ({
  useLiveTopic: (_topic: string, _params: unknown, handlers: { onJob: (job: Job) => void }) => {
    calls.onJob = handlers.onJob
    return 'live'
  },
}))

const { SectionJobs, jobTone } = await import('./section-jobs')

const job = (overrides: Partial<Job>): Job => ({
  id: 'j1',
  kind: 'storage.delete',
  section: 'storage',
  title: 'Delete users/ · 900 files',
  total: 900,
  done: 300,
  skipped: 0,
  errors: [],
  errorCount: 0,
  state: 'running',
  startedAt: new Date(Date.now() - 2_000).toISOString(),
  finishedAt: null,
  ...overrides,
})

function renderJobs(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
}

beforeEach(() => {
  calls.get.mockReset()
  calls.send.mockReset()
})
afterEach(cleanup)

describe('a section’s jobs', () => {
  it('say how far a running job got, with Cancel, and nothing once none runs', async () => {
    calls.get.mockResolvedValue({ jobs: [job({})] })
    calls.send.mockResolvedValue(job({ state: 'cancelled' }))
    renderJobs(<SectionJobs section="storage" verb={() => 'deleted'} testId="storage-job" />)
    expect(await screen.findByTestId('storage-job-progress')).toHaveTextContent(
      '300 of 900 deleted…',
    )
    expect(screen.getByTestId('storage-job')).toHaveTextContent('Delete users/ · 900 files')
    await userEvent.click(screen.getByTestId('storage-job-cancel'))
    expect(calls.send).toHaveBeenCalledWith('POST', '/jobs/j1/cancel', expect.anything())
  })

  it('keep a finished job’s summary a moment, with each failed item and the section’s why', async () => {
    const ended = vi.fn()
    calls.get.mockResolvedValue({ jobs: [job({})] })
    renderJobs(
      <SectionJobs
        section="storage"
        verb={() => 'deleted'}
        why={(error) => <Button size="xs">Why {error.key}</Button>}
        onEnded={ended}
        testId="storage-job"
      />,
    )
    await screen.findByTestId('storage-job')
    await act(async () =>
      calls.onJob?.(
        job({
          done: 898,
          state: 'done',
          errorCount: 2,
          errors: [{ key: 'users/a.png', message: 'Refused by the rules.' }],
          finishedAt: new Date().toISOString(),
        }),
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId('storage-job-progress')).toHaveTextContent(
        'Done: 898 of 900 deleted · 2 failed',
      ),
    )
    expect(screen.getByTestId('storage-job')).toHaveAttribute('data-tone', 'warning')
    expect(screen.queryByTestId('storage-job-cancel')).not.toBeInTheDocument()
    expect(ended).toHaveBeenCalledWith([expect.objectContaining({ id: 'j1', state: 'done' })])
    await userEvent.click(screen.getByTestId('storage-job-see-why'))
    expect(await screen.findByText('Refused by the rules.')).toBeInTheDocument()
    expect(screen.getByText('Why users/a.png')).toBeInTheDocument()
    expect(screen.getByText('and 1 more like these')).toBeInTheDocument()
  })

  it('show only the jobs asked for, under their own words', async () => {
    calls.get.mockResolvedValue({
      jobs: [
        job({
          id: 'p1',
          kind: 'pubsub.publish',
          section: 'pubsub',
          title: 'Publish to orders',
          total: null,
          done: 12,
        }),
        job({ id: 'p2', kind: 'pubsub.ack', section: 'pubsub', title: 'Ack 40 messages' }),
      ],
    })
    renderJobs(
      <SectionJobs
        section="pubsub"
        filter={(entry) => entry.kind === 'pubsub.publish'}
        verb={() => 'sent'}
        cancelLabel="Stop"
        summaryMs={0}
        testId="pubsub-job"
      />,
    )
    expect(await screen.findByTestId('pubsub-job-progress')).toHaveTextContent('12 sent…')
    expect(screen.getAllByTestId('pubsub-job')).toHaveLength(1)
    expect(screen.getByTestId('pubsub-job-cancel')).toHaveTextContent('Stop')
  })

  it('say why a job failed', async () => {
    calls.get.mockResolvedValue({
      jobs: [
        job({
          state: 'failed',
          message: 'The engine stopped.',
          finishedAt: new Date().toISOString(),
        }),
      ],
    })
    renderJobs(<SectionJobs section="storage" verb={() => 'deleted'} testId="storage-job" />)
    expect(await screen.findByTestId('storage-job-message')).toHaveTextContent(
      'The engine stopped.',
    )
    expect(screen.getByTestId('storage-job')).toHaveAttribute('data-tone', 'danger')
  })

  it('tone a failed job danger and one with failed items a warning once it ends', () => {
    expect(jobTone({ state: 'failed', errorCount: 0 })).toBe('danger')
    expect(jobTone({ state: 'done', errorCount: 3 })).toBe('warning')
    expect(jobTone({ state: 'running', errorCount: 3 })).toBe('info')
    expect(jobTone({ state: 'done', errorCount: 0 })).toBe('info')
  })
})
