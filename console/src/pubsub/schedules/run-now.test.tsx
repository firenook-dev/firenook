// U-18 for Run now: it asks first, says it runs the function's code, sends
// nothing on the key that opened it, runs on Enter, and says a refusal
// (background triggers paused) with its fix where it was asked.

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderInConsole } from '@/test/render'
import { testStatus } from '@/test/status'
import { runNowText, useRunNow } from './run-now-popover'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const NIGHTLY = {
  functionId: 'us-central1-nightlyCleanup',
  functionName: 'nightlyCleanup',
  paused: false,
}

function Harness() {
  const runNow = useRunNow('demo')
  return (
    <>
      <button type="button" onClick={(event) => runNow.ask(NIGHTLY, event.currentTarget)}>
        Run now…
      </button>
      {runNow.element}
    </>
  )
}

/** A fetch that answers `/schedule/run` with `answer`, recording what was asked. */
function engineAnswering(answer: Response) {
  const calls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return Promise.resolve(
      url.includes('/pubsub/schedule/run') ? answer.clone() : new Response('{}'),
    )
  })
  return calls
}

describe('Run now (U-18)', () => {
  it('asks first, and runs only on Enter', async () => {
    const calls = engineAnswering(
      Response.json({
        at: '2026-10-12T10:00:00Z',
        trigger: 'console',
        messageId: '51',
        skipped: null,
        delivery: null,
      }),
    )
    await renderInConsole(() => <Harness />, { status: testStatus({ projectId: 'demo' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Run now…' }))
    const confirm = await screen.findByTestId('pubsub-run-now')
    expect(confirm).toHaveTextContent('Run nightlyCleanup now?')
    expect(confirm).toHaveTextContent('It runs your function’s code')
    expect(calls.filter((url) => url.includes('/schedule/run'))).toHaveLength(0)
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('pubsub-run-now-confirm'), { key: 'Enter' })
    })
    await waitFor(() =>
      expect(calls.filter((url) => url.includes('/schedule/run'))).toHaveLength(1),
    )
    await waitFor(() => expect(screen.queryByTestId('pubsub-run-now')).toBeNull())
  })

  it('says a refusal where it was asked, with the fix', async () => {
    engineAnswering(
      Response.json(
        {
          error: {
            code: 'conflict',
            message: 'Background triggers are paused, so the tick was not published.',
            fix: 'Resume background triggers.',
          },
        },
        { status: 409 },
      ),
    )
    await renderInConsole(() => <Harness />, { status: testStatus({ projectId: 'demo' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Run now…' }))
    await screen.findByTestId('pubsub-run-now')
    await act(async () => {
      fireEvent.click(screen.getByTestId('pubsub-run-now-confirm'))
    })
    expect(await screen.findByTestId('pubsub-run-now-error')).toHaveTextContent(
      'Background triggers are paused, so the tick was not published. Resume background triggers.',
    )
    expect(screen.getByTestId('pubsub-run-now')).toBeInTheDocument()
  })

  it('says a paused schedule stays paused', () => {
    expect(runNowText({ ...NIGHTLY, paused: true }).description).toBe(
      'It runs your function’s code once. Its schedule stays paused.',
    )
  })
})
