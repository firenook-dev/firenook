import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import {
  ConfirmPopover,
  type ConfirmRequest,
  rowElement,
  useConfirmPopover,
} from './confirm-popover'

afterEach(cleanup)

/** Opens the page's confirmation the way a row menu does. */
function Asker({ request }: { request: ConfirmRequest }) {
  const confirm = useConfirmPopover()
  return (
    <>
      <button type="button" onClick={() => confirm.ask(request)}>
        ask
      </button>
      {confirm.element}
    </>
  )
}

const request = (run: ConfirmRequest['run']): ConfirmRequest => ({
  title: 'Run nightlyCleanup now?',
  description: 'It runs your function’s code once.',
  confirm: 'Run now',
  anchor: null,
  run,
  testId: 'run-now',
})

describe('the confirmation for running code again', () => {
  it('runs nothing until confirmed, then once, and closes', async () => {
    const run = vi.fn(() => Promise.resolve())
    render(<Asker request={request(run)} />)
    fireEvent.click(screen.getByText('ask'))
    const popover = await screen.findByTestId('run-now')
    expect(popover).toHaveTextContent('Run nightlyCleanup now?')
    expect(screen.getByTestId('run-now-description')).toHaveTextContent(
      'It runs your function’s code once.',
    )
    expect(run).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByTestId('run-now-confirm')))
    expect(run).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId('run-now')).not.toBeInTheDocument())
  })

  it('answers Enter anywhere but on Cancel, and Cancel runs nothing', async () => {
    const run = vi.fn(() => Promise.resolve())
    render(<Asker request={request(run)} />)
    fireEvent.click(screen.getByText('ask'))
    const cancel = await screen.findByTestId('run-now-cancel')
    fireEvent.keyDown(cancel, { key: 'Enter' })
    expect(run).not.toHaveBeenCalled()
    fireEvent.click(cancel)
    await waitFor(() => expect(screen.queryByTestId('run-now')).not.toBeInTheDocument())
    fireEvent.click(screen.getByText('ask'))
    const description = await screen.findByTestId('run-now-description')
    await act(async () => fireEvent.keyDown(description, { key: 'Enter' }))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('stays open with the engine’s words and its fix when the run is refused, and asks afresh', async () => {
    const run = vi.fn(() =>
      Promise.reject(
        new ApiError(
          409,
          'Background triggers are paused.',
          'conflict',
          'Resume them in the top bar.',
        ),
      ),
    )
    render(<Asker request={request(run)} />)
    fireEvent.click(screen.getByText('ask'))
    await act(async () => fireEvent.click(await screen.findByTestId('run-now-confirm')))
    expect(await screen.findByTestId('run-now-error')).toHaveTextContent(
      'Background triggers are paused. Resume them in the top bar.',
    )
    fireEvent.click(screen.getByText('ask'))
    await waitFor(() => expect(screen.queryByTestId('run-now-error')).not.toBeInTheDocument())
  })

  it('carries an option the run reads, with the page holding it open', async () => {
    const runs: boolean[] = []
    function Page() {
      const [open, setOpen] = useState(true)
      const [keep, setKeep] = useState(false)
      return (
        <ConfirmPopover
          open={open}
          onOpenChange={setOpen}
          title={keep ? 'Publish it again with its own id?' : 'Publish it again with a new id?'}
          description="Every trigger that listens runs again."
          confirm="Replay"
          option={{ label: 'Keep the id', checked: keep, onChange: setKeep }}
          run={() => {
            runs.push(keep)
          }}
          testId="event-replay"
        />
      )
    }
    render(<Page />)
    const popover = await screen.findByTestId('event-replay')
    expect(popover).toHaveTextContent('with a new id')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Keep the id' }))
    expect(popover).toHaveTextContent('with its own id')
    await act(async () => fireEvent.click(screen.getByTestId('event-replay-confirm')))
    expect(runs).toEqual([true])
    await waitFor(() => expect(screen.queryByTestId('event-replay')).not.toBeInTheDocument())
  })

  it('finds a row to hang off by its table and key', () => {
    render(
      <div data-testid="tasks">
        <div data-key="order/1">row</div>
      </div>,
    )
    expect(rowElement('tasks', 'order/1')).toHaveTextContent('row')
    expect(rowElement('tasks', 'order/2')).toBeNull()
  })
})
