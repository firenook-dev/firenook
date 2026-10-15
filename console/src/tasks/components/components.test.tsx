import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { TasksTaskDetail } from '@/api/generated/messaging/TasksTaskDetail'
import { SectionGate } from '@/components/console/section-gate'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import type { TasksAttemptEvent } from '@/api/generated/messaging/TasksAttemptEvent'
import { useFeedPending } from '@/components/console/feed-list'
import { PauseButton } from '@/components/console/pause-button'
import type { FeedStore } from '@/lib/live/feed-store'
import { dispatchShortcut } from '@/lib/shortcuts'
import { attemptKey, createAttemptsStore } from '../live'
import { tasksKeys } from '../queries'
import {
  LOCATION,
  PROJECT,
  testAttempt,
  testCounters,
  testDetail,
  testList,
  testQueue,
  testRow,
} from '../fixtures.test-support'
import { AttemptsView } from './attempts-feed'
import { AttemptsTimeline } from './attempts-timeline'
import { type ConfirmRequest, useConfirmPopover } from '@/messaging/confirm-popover'
import { QueuesLanding } from './queues-landing'
import { panelNodes } from './queues-panel'
import { meantQueue, refusedText } from './refused-banner'
import { replacedText } from './replaced-banner'
import type { TaskActions } from './task-actions'
import { SLOW_DISCOVERY_MS, TasksStarting } from './tasks-starting'
import { TaskInspector } from './task-inspector'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** A status with Cloud Tasks ready, and fetch held so nothing reaches a network. */
function ready() {
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
  return testStatus({ sections: [sectionEntry('tasks'), sectionEntry('functions')] })
}

describe('the section states (U-18)', () => {
  it('say why Cloud Tasks is absent, with the fix', async () => {
    const status = testStatus({
      sections: [
        sectionEntry('tasks', {
          state: 'absent',
          reason: 'requires',
          detail: 'Cloud Tasks runs with Functions, which this engine does not run.',
          fixes: [
            {
              label: 'Start with Functions',
              kind: 'command',
              text: 'firenook emulators:start --only functions',
            },
          ],
        }),
      ],
    })
    await renderInConsole(
      () => (
        <SectionGate section="tasks">
          <p>the tasks page</p>
        </SectionGate>
      ),
      { status },
    )
    expect(screen.queryByText('the tasks page')).not.toBeInTheDocument()
    expect(
      screen.getByText('Cloud Tasks runs with Functions, which this engine does not run.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('fix-command')).toHaveTextContent('--only functions')
  })

  it('wait for a starting Cloud Tasks and fill in when it is ready', async () => {
    const status = testStatus({
      sections: [
        sectionEntry('tasks', {
          state: 'starting',
          detail: 'Waiting for Functions discovery. Queues register from onTaskDispatched exports.',
        }),
      ],
    })
    const { client } = await renderInConsole(
      () => (
        <SectionGate section="tasks">
          <p>the tasks page</p>
        </SectionGate>
      ),
      { status },
    )
    expect(screen.getByTestId('service-starting')).toBeInTheDocument()
    act(() => client.setQueryData(['status'], { ...status, sections: [sectionEntry('tasks')] }))
    expect(await screen.findByText('the tasks page')).toBeInTheDocument()
  })
})

describe('a slow start (TK-70)', () => {
  it('says where to look once discovery has run for 30 seconds', async () => {
    vi.useFakeTimers()
    try {
      await renderInConsole(() => <TasksStarting />, { status: ready() })
      expect(screen.queryByTestId('tasks-slow-discovery')).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(SLOW_DISCOVERY_MS))
      expect(screen.getByTestId('tasks-slow-discovery')).toHaveTextContent(
        'Functions discovery has not finished after 30 seconds',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the Queues panel (TK-01)', () => {
  const processOrder = testQueue('processOrder', {
    counters: testCounters({ pending: 12, held: 1, running: 2, backoff: 1 }),
  })
  const paused = testQueue('sendEmail', { paused: true })

  it('lists each queue with what waits and what holds a slot, except the one on screen', () => {
    const nodes = panelNodes(testList([processOrder, paused]), paused.key)
    expect(nodes.map((node) => [node.label, node.count])).toEqual([
      ['processOrder', '13 · 3'],
      ['sendEmail', undefined],
    ])
    expect(nodes[0]?.title).toContain('13 waiting (1 held) · 3 in a slot (1 in backoff)')
    expect(nodes[1]?.title).toContain('Paused: tasks wait until you resume.')
    expect(nodes[1]?.icon).not.toBe(nodes[0]?.icon)
  })

  it('names a queue with its location where two locations register its id', () => {
    const east = testQueue('processOrder', {}, 'us-east1')
    const nodes = panelNodes(testList([processOrder, east]), undefined)
    expect(nodes.map((node) => node.label)).toEqual([
      'processOrder · us-central1',
      'processOrder · us-east1',
    ])
  })

  it('groups the refused registrations and enqueues, only when there are any', () => {
    expect(panelNodes(testList([processOrder]), undefined)).toHaveLength(1)
    const nodes = panelNodes(
      testList([processOrder], {
        rejectedRegistrations: [
          {
            functionId: `${LOCATION}-badQueue_1`,
            name: 'badQueue_1',
            region: LOCATION,
            reason: 'Queue ID must only contain letters, numbers and hyphens.',
            at: '2026-10-12T10:00:00.000Z',
          },
        ],
        refused: [
          {
            firstAt: '2026-10-12T10:00:00.000Z',
            lastAt: '2026-10-12T10:01:00.000Z',
            count: 4,
            operation: 'enqueue',
            project: PROJECT,
            location: 'us-east1',
            queue: 'processOrder',
            status: 404,
            error: 'Tried to queue a task from a non-existent queue',
            suggestion: 'processOrder is registered in us-central1',
          },
        ],
      }),
      undefined,
    )
    expect(nodes.map((node) => node.label)).toEqual([
      'processOrder',
      'Not registered',
      'Refused enqueues',
    ])
    expect(nodes[1]?.children?.[0]?.label).toBe('badQueue_1')
    expect(nodes[2]?.children?.[0]).toMatchObject({ label: 'us-east1/processOrder', count: '×4' })
  })
})

describe('refusals and re-registrations, said (TK-01a, TK-62)', () => {
  const refused = {
    firstAt: '2026-10-12T10:00:00.000Z',
    lastAt: '2026-10-12T10:01:00.000Z',
    count: 4,
    operation: 'enqueue',
    project: PROJECT,
    location: 'us-east1',
    queue: 'processOrder',
    status: 404,
    error: 'Tried to queue a task from a non-existent queue',
    suggestion: 'processOrder is registered in us-central1',
  }

  it('say what was refused, how often, the answer verbatim and where the queue is', () => {
    expect(refusedText(refused)).toBe(
      'Enqueue into us-east1/processOrder refused 4 times with 404 “Tried to queue a task from a non-existent queue”. processOrder is registered in us-central1.',
    )
    expect(refusedText({ ...refused, count: 1, operation: 'delete', suggestion: null })).toBe(
      'Delete in us-east1/processOrder refused once with 404 “Tried to queue a task from a non-existent queue”.',
    )
    expect(meantQueue(refused, [testQueue('processOrder')])?.location).toBe(LOCATION)
    expect(
      meantQueue({ ...refused, location: LOCATION }, [testQueue('processOrder')]),
    ).toBeUndefined()
  })

  it('say a re-registration dropped tasks into History', () => {
    expect(
      replacedText({
        id: 'processOrder',
        lastReplaced: { at: '2026-10-12T10:14:03.000Z', dropped: 3 },
      }),
    ).toMatch(
      /^processOrder re-registered at \d\d:\d\d:\d\d with new options; 3 tasks were dropped \(see History\)\.$/,
    )
    expect(replacedText({ id: 'processOrder', lastReplaced: null })).toBeUndefined()
  })
})

describe('the attempts timeline (TK-22)', () => {
  it('keeps the first attempt, counts those not kept, and shows what comes next', async () => {
    const detail = testDetail({
      task: testRow({
        key: '0.7',
        state: 'backoff',
        position: null,
        attempt: 14,
        lastAttemptAt: new Date(Date.now()).toISOString(),
        nextAttemptAt: new Date(Date.now() + 4_000).toISOString(),
      }),
      attempts: [
        testAttempt({ attempt: 1 }),
        testAttempt({ attempt: 14, retryCount: 13, startedAt: '2026-10-12T10:04:02.311Z' }),
      ],
      omittedAttempts: 12,
      retryPlan: [
        {
          attempt: 15,
          earliestAt: new Date(Date.now() + 4_000).toISOString(),
          backoffSeconds: 4,
          last: false,
        },
      ],
    })
    await renderInConsole(() => <AttemptsTimeline detail={detail} queue={testQueue()} />, {
      status: ready(),
    })
    const attempts = screen.getAllByTestId('attempt')
    expect(attempts.map((row) => row.dataset.attempt)).toEqual(['1', '14'])
    expect(screen.getByTestId('attempts-omitted')).toHaveTextContent(
      '12 attempts in between not kept',
    )
    expect(within(attempts[0] as HTMLElement).getByTestId('attempt-status')).toHaveTextContent(
      '500',
    )
    expect(within(attempts[0] as HTMLElement).getByTestId('attempt-response')).toHaveTextContent(
      'card declined',
    )
    expect(screen.getByTestId('attempt-backoff')).toHaveTextContent('backoff 4 s')
    expect(screen.getByTestId('attempt-next')).toHaveTextContent(
      /next at \d\d:\d\d:\d\d · in [45] s/,
    )
    // Each kept attempt opens its function's lines around it in Logs.
    expect(screen.getAllByTestId('attempt-logs').map((link) => link.getAttribute('href'))).toEqual([
      expect.stringContaining('/logs?q=function%3Aus-central1-processOrder&from='),
      expect.stringContaining('/logs?q=function%3Aus-central1-processOrder&from='),
    ])
    // While this engine runs no Logs: no link into a page that cannot show them.
    cleanup()
    await renderInConsole(() => <AttemptsTimeline detail={detail} queue={testQueue()} />, {
      status: testStatus({
        sections: [
          sectionEntry('tasks'),
          sectionEntry('functions'),
          sectionEntry('logs', { state: 'absent' }),
        ],
      }),
    })
    expect(screen.getAllByTestId('attempt')).toHaveLength(2)
    expect(screen.queryByTestId('attempt-logs')).not.toBeInTheDocument()
  })
})

/** Opens the confirmation the way a row menu does, and reports what ran. */
function Confirmer({ request }: { request: ConfirmRequest }) {
  const confirm = useConfirmPopover()
  return (
    <>
      <button type="button" onClick={() => confirm.ask(request)}>
        open
      </button>
      {confirm.element}
    </>
  )
}

describe('Run now asks first (U-18)', () => {
  it('runs nothing until confirmed, then runs once and closes', async () => {
    const run = vi.fn(() => Promise.resolve())
    await renderInConsole(
      () => (
        <Confirmer
          request={{
            title: 'Run order-1 now?',
            description: "It runs processOrder's code.",
            confirm: 'Run now',
            anchor: null,
            run,
            testId: 'run-confirm',
          }}
        />
      ),
      { status: ready() },
    )
    fireEvent.click(screen.getByText('open'))
    expect(await screen.findByTestId('run-confirm')).toHaveTextContent('Run order-1 now?')
    expect(run).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByTestId('run-confirm-confirm')))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps the confirmation open with the engine’s words when the run is refused', async () => {
    const run = vi.fn(() =>
      Promise.reject(
        new ApiError(
          409,
          'Every dispatch slot of processOrder is busy.',
          'conflict',
          'Wait for a running task to finish, or raise maxConcurrentDispatches.',
        ),
      ),
    )
    await renderInConsole(
      () => (
        <Confirmer
          request={{
            title: 'Run order-1 now?',
            description: 'x',
            confirm: 'Run now',
            anchor: null,
            run,
            testId: 'run-confirm',
          }}
        />
      ),
      { status: ready() },
    )
    fireEvent.click(screen.getByText('open'))
    await screen.findByTestId('run-confirm')
    await act(async () => fireEvent.click(screen.getByTestId('run-confirm-confirm')))
    expect(await screen.findByTestId('run-confirm-error')).toHaveTextContent(
      'Every dispatch slot of processOrder is busy. Wait for a running task to finish, or raise maxConcurrentDispatches.',
    )
  })
})

function fakeActions(): TaskActions {
  return {
    run: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    again: vi.fn(),
    edit: vi.fn(),
    open: vi.fn(),
    confirm: vi.fn(),
    element: null,
  }
}

async function inspect(detail: TasksTaskDetail, actions = fakeActions()) {
  const queue = testQueue()
  const view = await renderInConsole(
    () => (
      <TaskInspector
        queue={queue}
        project={PROJECT}
        taskId={detail.task.id}
        tab="payload"
        onTab={() => {}}
        onClose={() => {}}
        actions={actions}
      />
    ),
    { status: ready() },
  )
  act(() => view.client.setQueryData(tasksKeys.task(PROJECT, queue.key, detail.task.id), detail))
  await screen.findByTestId('task-state')
  return actions
}

describe('the task inspector (TK-20…TK-24)', () => {
  it('offers Run now for a pending task, and runs it only through the actions', async () => {
    const actions = await inspect(testDetail())
    expect(screen.getByTestId('task-state-word')).toHaveTextContent('pending · #1')
    expect(screen.getByTestId('task-payload')).toHaveTextContent('as the handler reads it')
    fireEvent.click(screen.getByTestId('task-run'))
    expect(actions.run).toHaveBeenCalledWith(
      { id: '7', label: 'order-1', generated: false },
      expect.any(HTMLElement),
    )
    expect(screen.queryByTestId('task-stop')).not.toBeInTheDocument()
  })

  it('offers Stop retrying and the retry plan in backoff, and no Run now while running', async () => {
    await inspect(
      testDetail({
        task: testRow({ state: 'backoff', key: '0.7', position: null, attempt: 2 }),
        retryPlan: [
          { attempt: 3, earliestAt: '2026-10-12T10:02:31.000Z', backoffSeconds: 2, last: false },
          { attempt: 4, earliestAt: '2026-10-12T10:02:35.000Z', backoffSeconds: 4, last: true },
        ],
      }),
    )
    expect(screen.getByTestId('task-stop')).toBeInTheDocument()
    expect(screen.getByTestId('task-retry-plan')).toHaveTextContent('last')
    cleanup()
    await inspect(
      testDetail({ task: testRow({ state: 'running', key: '0.7', position: null, attempt: 1 }) }),
    )
    expect(screen.queryByTestId('task-run')).not.toBeInTheDocument()
  })

  it('reads a finished task, with Enqueue again opening the dialog filled from it', async () => {
    const actions = await inspect(
      testDetail({
        task: testRow({ state: 'finished', position: null, previousResponse: 204, attempt: 1 }),
        finished: { outcome: 'succeeded', at: '2026-10-12T10:02:16.000Z', tookMs: 1000 },
      }),
    )
    expect(screen.getByTestId('task-outcome')).toHaveTextContent('succeeded')
    expect(screen.queryByTestId('task-delete-button')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-enqueue-again'))
    expect(actions.edit).toHaveBeenCalledWith('7')
  })
})

/** The Attempts tab as the queue view lays it out: the feed, and row two's pause. */
function AttemptsHarness({ store }: { store: FeedStore<TasksAttemptEvent> }) {
  const [paused, setPaused] = useState(false)
  const pending = useFeedPending(store, paused, attemptKey)
  return (
    <>
      <PauseButton paused={paused} pending={pending} onChange={setPaused} testId="attempts-pause" />
      <AttemptsView
        queue={testQueue()}
        store={store}
        paused={paused}
        onPaused={setPaused}
        onOpen={() => {}}
        banners={null}
        inspector={() => null}
        taskId={undefined}
      />
    </>
  )
}

const attemptEvent = (attempt: number): TasksAttemptEvent => ({
  queue: testQueue().key,
  taskId: '7',
  taskName: 'order-1',
  attempt: testAttempt({ attempt, retryCount: attempt - 1 }),
})

describe('the Attempts feed’s pause (U-18)', () => {
  it('p holds the feed still and counts what arrives; p again lets it in', async () => {
    const store = createAttemptsStore()
    store.push([attemptEvent(1)])
    await renderInConsole(() => <AttemptsHarness store={store} />, { status: ready() })
    const button = screen.getByTestId('attempts-pause')
    expect(button).toHaveTextContent(/^Pause$/)
    act(() => dispatchShortcut(new KeyboardEvent('keydown', { key: 'p' })))
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveTextContent(/^Paused$/)

    // The store tells its readers on the next frame.
    act(() => store.push([attemptEvent(2), attemptEvent(3)]))
    await waitFor(() => expect(button).toHaveTextContent('Paused · 2 new'))

    act(() => dispatchShortcut(new KeyboardEvent('keydown', { key: 'p' })))
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveTextContent(/^Pause$/)
    expect(store.size()).toBe(3)
    expect(store.pending()).toBe(0)
  })
})

describe('the queue list (U-18)', () => {
  it('draws no banner of its own about other projects or background triggers', async () => {
    await renderInConsole(
      () => (
        <QueuesLanding
          list={testList([testQueue()], { projects: [PROJECT, 'demo-other'] })}
          missing={undefined}
          onOpen={() => {}}
          onEnqueue={() => {}}
          project={PROJECT}
        />
      ),
      { status: ready() },
    )
    expect(await screen.findByTestId('queue-field')).toHaveTextContent(`Task queues${PROJECT}`)
    expect(screen.queryByText(/demo-other/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Background triggers/)).not.toBeInTheDocument()
  })
})
