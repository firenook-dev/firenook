import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/api/generated/Job'
import type { TriggersAnswer } from '@/lib/triggers'
import { renderInConsole } from '@/test/render'
import { testStatus } from '@/test/status'

// The job comes from GET /jobs/{id} and the `jobs` topic; both are stood in
// for, so the dialog's own reading of a job is what is tested.
const calls = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  apiGet: calls.get,
  apiSend: calls.send,
}))
vi.mock('@/lib/live/use-live-topic', () => ({ useLiveTopic: () => 'live' }))

const { DangerConfirm, DangerConfirmBody, jobProgress, triggerLine } =
  await import('./danger-confirm')

afterEach(() => {
  cleanup()
  calls.get.mockReset()
  calls.send.mockReset()
})

const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'j1',
  kind: 'storage.delete',
  section: 'storage',
  title: 'Delete 1,204 objects',
  total: 1204,
  done: 412,
  skipped: 2,
  errors: [],
  errorCount: 0,
  state: 'running',
  startedAt: '2026-10-12T06:00:00Z',
  finishedAt: null,
  ...overrides,
})

const onUserDeleted = {
  functionId: 'us-central1-onUserDeleted',
  codebase: 'default',
  eventType: 'providers/firebase.auth/eventTypes/user.delete',
  kind: 'auth',
}

function dialog(props: Partial<Parameters<typeof DangerConfirm>[0]> = {}) {
  const onOpenChange = vi.fn()
  const onConfirm = vi.fn()
  return {
    onOpenChange,
    onConfirm,
    ui: () => (
      <DangerConfirm
        open
        onOpenChange={onOpenChange}
        title="Delete 3 users"
        description="u_9f3k2, u_2fc4c and u_2s5rh are removed from the emulator."
        consequences={['Re-seed or re-import to get them back.']}
        pending={false}
        onConfirm={onConfirm}
        {...props}
      />
    ),
  }
}

describe('a destructive confirmation', () => {
  it('says what fires: each function and how often, nothing, or paused', async () => {
    const answer: TriggersAnswer = { functions: [onUserDeleted], backgroundEnabled: true }
    const { ui } = dialog({ triggers: { answer, times: 3 } })
    await renderInConsole(ui, { status: testStatus() })
    expect(screen.getByTestId('danger-confirm-triggers')).toHaveTextContent(
      'onUserDeleted runs 3 times.',
    )
    expect(screen.getByText('Re-seed or re-import to get them back.')).toBeInTheDocument()

    expect(triggerLine({ functions: [], backgroundEnabled: true }, 3, { enabled: true })).toEqual({
      kind: 'none',
    })
    expect(triggerLine(answer, 1, { enabled: false })).toEqual({ kind: 'paused' })
    expect(
      triggerLine({ functions: [onUserDeleted], backgroundEnabled: false }, 1, undefined),
    ).toEqual({
      kind: 'paused',
    })
  })

  it('draws no trigger line while the answer is unknown or Functions are absent', async () => {
    const { ui } = dialog({ triggers: { answer: 'unknown', times: 3 } })
    await renderInConsole(ui, { status: testStatus() })
    expect(screen.queryByTestId('danger-confirm-triggers')).not.toBeInTheDocument()
    expect(triggerLine('absent', 3, { enabled: true })).toBeUndefined()
  })

  it('says "No function listens" and "paused" in words', async () => {
    const { ui } = dialog({
      triggers: { answer: { functions: [], backgroundEnabled: true }, times: 3 },
    })
    await renderInConsole(ui, { status: testStatus() })
    expect(screen.getByTestId('danger-confirm-triggers')).toHaveTextContent(
      'No function listens to this.',
    )
    cleanup()
    const paused = dialog({
      triggers: { answer: { functions: [onUserDeleted], backgroundEnabled: true }, times: 3 },
    })
    await renderInConsole(paused.ui, {
      status: testStatus({
        backgroundTriggers: { enabled: false, since: '2026-10-12T06:00:00Z', dropped: [] },
      }),
    })
    expect(screen.getByTestId('danger-confirm-triggers')).toHaveTextContent(
      'Background triggers are paused; no function runs.',
    )
  })

  it('gates the button on the exact text, case and all', async () => {
    const { ui, onConfirm } = dialog({ confirmText: 'demo.appspot.com' })
    await renderInConsole(ui, { status: testStatus() })
    const confirm = screen.getByTestId('danger-confirm-confirm')
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByTestId('danger-confirm-type'), 'DEMO.appspot.com')
    expect(confirm).toBeDisabled()
    await userEvent.clear(screen.getByTestId('danger-confirm-type'))
    await userEvent.type(screen.getByTestId('danger-confirm-type'), 'demo.appspot.com')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('follows the job: progress with skipped items, failures and why, and Cancel stops it', async () => {
    calls.get.mockResolvedValue(
      job({
        errorCount: 3,
        errors: [{ key: 'avatars/a.png', message: 'Denied by the storage rules.' }],
      }),
    )
    calls.send.mockResolvedValue(job({ state: 'cancelled' }))
    const { ui, onOpenChange } = dialog({ jobId: 'j1' })
    await renderInConsole(ui, { status: testStatus() })
    expect(await screen.findByTestId('danger-confirm-progress')).toHaveTextContent(
      '412 of 1,204 deleted · 2 skipped · 3 failed…',
    )
    await userEvent.click(screen.getByTestId('danger-confirm-why'))
    expect(screen.getByText('Denied by the storage rules.')).toBeInTheDocument()
    expect(screen.getByText('and 2 more like these')).toBeInTheDocument()
    // Escape does not leave a running job unseen.
    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    await userEvent.click(screen.getByTestId('danger-confirm-cancel'))
    expect(calls.send).toHaveBeenCalledWith('POST', '/jobs/j1/cancel', {})
  })

  it('keeps an error on screen', async () => {
    const { ui } = dialog({ error: 'Another bulk action is still running in Storage.' })
    await renderInConsole(ui, { status: testStatus() })
    expect(screen.getByTestId('danger-confirm-error')).toHaveTextContent(
      'Another bulk action is still running in Storage.',
    )
  })

  it('writes the job in words for each state', () => {
    expect(jobProgress(job({ total: null, skipped: 0 }), 'deleted')).toBe('412 deleted…')
    expect(jobProgress(job({ state: 'done', done: 1204, skipped: 0 }), 'deleted')).toBe(
      'Done: 1,204 of 1,204 deleted',
    )
    expect(jobProgress(job({ state: 'cancelled' }), 'purged')).toBe(
      'Stopped: 412 of 1,204 purged · 2 skipped',
    )
    expect(jobProgress(job({ state: 'failed', skipped: 0 }), 'deleted')).toBe(
      'Failed: 412 of 1,204 deleted',
    )
  })
})

describe('the confirmation outside its dialog', () => {
  it('draws the same words and controls at rest, at any point of a job it is handed', async () => {
    await renderInConsole(
      () => (
        <>
          <DangerConfirmBody
            title="Delete 3 users"
            description="u_9f3k2 and 2 more are removed from the emulator."
            line={{ kind: 'functions', functions: [onUserDeleted], times: 3 }}
            consequences={['Re-seed or re-import to get them back.']}
            testId="at-rest"
          />
          <DangerConfirmBody
            title="Delete every object"
            description="1,204 objects are removed."
            confirmText="demo.appspot.com"
            typed="demo.appspot.com"
            job={job({ state: 'done', done: 1204, finishedAt: '2026-10-12T06:00:05Z' })}
            testId="done"
          />
        </>
      ),
      { status: testStatus() },
    )
    const rest = screen.getByTestId('at-rest')
    expect(rest.textContent).toContain('onUserDeleted runs 3 times.')
    expect(rest.textContent).toContain('Re-seed or re-import to get them back.')
    expect(screen.getByTestId('at-rest-confirm').textContent).toBe('Delete 3 users')
    // Done: the job's own words, Close and no confirm.
    expect(screen.getByTestId('done-progress').textContent).toContain(
      'Done: 1,204 of 1,204 deleted · 2 skipped',
    )
    expect(screen.getByTestId('done-cancel').textContent).toBe('Close')
    expect(screen.queryByTestId('done-confirm')).toBeNull()
    expect(screen.getByLabelText('Type demo.appspot.com to confirm')).toHaveValue(
      'demo.appspot.com',
    )
  })

  it('says how far work that is not a job has got, while it runs', async () => {
    await renderInConsole(
      () => (
        <DangerConfirmBody
          title="Delete 40 documents"
          description="They are removed from the emulator."
          pending
          progress="12 of 40 deleted…"
          testId="looping"
        />
      ),
      { status: testStatus() },
    )
    expect(screen.getByTestId('looping-progress').textContent).toBe('12 of 40 deleted…')
  })
})
