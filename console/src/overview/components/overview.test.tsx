import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { Job } from '@/api/generated/Job'
import type { OverviewState } from '@/api/generated/observe/OverviewState'
import { statusQuery } from '@/api/queries'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import { sectionCards } from '../model'
import { createNoticeStore } from '../notices'
import type { SnapshotView } from '../snapshot'
import { ConnectSection } from './connect'
import { DataCards } from './data-section'
import { Notices } from './notices'
import { RecentProblems } from './problems'
import { SectionCard } from './section-card'

const services = [
  { name: 'firestore', host: '127.0.0.1', port: 8080, listening: true, pid: null },
  { name: 'auth', host: '127.0.0.1', port: 9099, listening: true, pid: null },
  { name: 'hub', host: '127.0.0.1', port: 4400, listening: true, pid: null },
]

const withDocuments = (documents: number): ConsoleStatus =>
  testStatus({
    projectId: 'demo-overview',
    services,
    sections: [
      sectionEntry('firestore', {
        summary: {
          headline: `${documents} documents · 1 database`,
          figures: [
            { label: 'Documents', value: documents, unit: 'count' },
            { label: 'Databases', value: 1, unit: 'count' },
          ],
        },
      }),
    ],
  })

const state = (overrides: Partial<OverviewState> = {}): OverviewState => ({
  generatedAt: '2026-10-12T04:06:09.117Z',
  notices: [],
  problems: [],
  hour: Array.from({ length: 60 }, () => ({ debug: 0, info: 2, warn: 0, error: 0 })),
  logs: { entries: 120, errors: 0, warnings: 0, problems: 0 },
  ...overrides,
})

/** A settled query result holding `data`, as the page passes it down. */
const answered = (data: OverviewState) =>
  ({
    data,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }) as unknown as UseQueryResult<OverviewState>

beforeEach(() => {
  localStorage.clear()
})
afterEach(cleanup)

const figure = () => screen.getByTestId('overview-figure-firestore-documents')

/** The Firestore card, drawn from the status in the query cache as the page draws it. */
function LiveCard() {
  const status = useQuery(statusQuery).data
  const [card] = status ? sectionCards(status, new Map()) : []
  return card && status ? <SectionCard card={card} tick={status} onConnect={() => {}} /> : null
}

describe('a section card', () => {
  it('shows the address, the figures the section counts, its links and its health', async () => {
    const status = withDocuments(1596)
    const [card] = sectionCards(status, new Map())
    if (!card) throw new Error('no card')
    await renderInConsole(() => <SectionCard card={card} tick={status} onConnect={() => {}} />, {
      status,
    })
    const article = screen.getByTestId('overview-card-firestore')
    expect(within(article).getByTestId('overview-card-firestore-address')).toHaveTextContent(
      '127.0.0.1:8080',
    )
    expect(screen.getByTestId('overview-figure-firestore-documents')).toHaveTextContent('1,596')
    expect(within(article).getByText('Databases')).toBeInTheDocument()
    expect(within(article).getByRole('link', { name: 'Open Firestore' })).toBeInTheDocument()
    expect(within(article).getByRole('link', { name: 'Rules' })).toBeInTheDocument()
    expect(screen.getByTestId('overview-card-firestore-health')).toHaveTextContent('Running')
    expect(screen.queryByTestId('overview-card-firestore-holds')).not.toBeInTheDocument()
  })

  it('says what a section holds while it counts nothing, never a made-up figure', async () => {
    const status = testStatus({
      projectId: 'demo-overview',
      services,
      sections: [sectionEntry('firestore')],
    })
    const [card] = sectionCards(status, new Map())
    if (!card) throw new Error('no card')
    await renderInConsole(() => <SectionCard card={card} tick={status} onConnect={() => {}} />, {
      status,
    })
    expect(screen.getByTestId('overview-card-firestore-holds')).toHaveTextContent(
      'Documents in every database, and the rules that guard them.',
    )
    expect(screen.queryByTestId('overview-card-firestore-figures')).not.toBeInTheDocument()
  })

  it('flashes a figure that changed, and only once in a burst of changes', async () => {
    const view = await renderInConsole(() => <LiveCard />, { status: withDocuments(10) })
    expect(figure()).toHaveAttribute('data-flashes', '0')
    const set = (documents: number) =>
      act(() => {
        view.client.setQueryData(['status'], withDocuments(documents))
      })
    set(11)
    await waitFor(() => expect(figure()).toHaveTextContent('11'))
    expect(figure()).toHaveAttribute('data-flashes', '1')
    set(12)
    await waitFor(() => expect(figure()).toHaveTextContent('12'))
    set(13)
    await waitFor(() => expect(figure()).toHaveTextContent('13'))
    expect(figure()).toHaveAttribute('data-flashes', '1')
  })

  it('offers its snippet in "Connect your app"', async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn()
    const status = withDocuments(1)
    const [card] = sectionCards(status, new Map())
    if (!card) throw new Error('no card')
    await renderInConsole(() => <SectionCard card={card} tick={status} onConnect={onConnect} />, {
      status,
    })
    await user.click(screen.getByTestId('overview-card-firestore-connect'))
    expect(onConnect).toHaveBeenCalledWith('web')
  })

  it('opens the Functions output in Logs from the Functions card, and from no other', async () => {
    const status = testStatus({
      projectId: 'demo-overview',
      services: [
        ...services,
        { name: 'functions', host: '127.0.0.1', port: 5001, listening: true, pid: null },
      ],
      sections: [sectionEntry('firestore'), sectionEntry('functions'), sectionEntry('logs')],
    })
    const cards = sectionCards(status, new Map())
    await renderInConsole(
      () =>
        cards.map((card) => (
          <SectionCard key={card.section.id} card={card} tick={status} onConnect={() => {}} />
        )),
      { status },
    )
    expect(screen.getByTestId('overview-card-functions-logs')).toHaveAttribute(
      'href',
      '/logs?q=service%3Afunctions',
    )
    expect(screen.queryByTestId('overview-card-firestore-logs')).not.toBeInTheDocument()
  })
})

describe('configuration notices', () => {
  it('title each with the engine’s first sentence, and put one away for this engine run', async () => {
    const user = userEvent.setup()
    const store = createNoticeStore(localStorage)
    expect(store.isDismissed('nonDemoProject', 'instance-1')).toBe(false)
    await renderInConsole(
      () => (
        <Notices
          notices={[
            {
              level: 'warn',
              code: 'nonDemoProject',
              message:
                'Project ID "shop-dev" is not a demo project. Code with real credentials can still reach it.',
            },
          ]}
          instance="instance-1"
        />
      ),
      { status: testStatus() },
    )
    const notice = screen.getByTestId('overview-notice-nonDemoProject')
    expect(notice).toHaveTextContent('Project ID "shop-dev" is not a demo project.')
    expect(notice).toHaveTextContent('Code with real credentials can still reach it.')
    await user.click(screen.getByTestId('overview-notice-nonDemoProject-dismiss'))
    expect(screen.queryByTestId('overview-notice-nonDemoProject')).not.toBeInTheDocument()
    expect(localStorage.getItem('firenook.console.notice.nonDemoProject.instance-1')).toBe('1')
  })
})

describe('recent problems', () => {
  it('say in one line that there are none', async () => {
    const status = withDocuments(1)
    await renderInConsole(
      () => <RecentProblems status={status} state={answered(state())} live="live" />,
      {
        status,
      },
    )
    expect(screen.getByTestId('overview-problems-empty')).toHaveTextContent(
      'No errors, failures or denials since the engine started.',
    )
    // With Logs built the bars are a control: a bar opens that minute's problems.
    expect(
      screen.getByRole('group', { name: 'Warnings and errors per minute, last hour' }),
    ).toBeInTheDocument()
  })

  it('say "just now" for a problem logged late in the current minute', async () => {
    // A clock that turns once a minute would put this line 58 s in the future: "in 1 min".
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-12T04:06:59.000Z'))
    try {
      const status = withDocuments(1)
      await renderInConsole(
        () => (
          <RecentProblems
            status={status}
            live="live"
            state={answered(
              state({
                generatedAt: '2026-10-12T04:06:58.900Z',
                logs: { entries: 120, errors: 1, warnings: 0, problems: 1 },
                problems: [
                  {
                    cursor: 'e1.9',
                    time: '2026-10-12T04:06:58.500Z',
                    level: 'error',
                    kind: null,
                    source: 'functions[us-central1-fails]',
                    firstLine: "TypeError: cannot read 'id' of undefined",
                    refs: [],
                  },
                ],
              }),
            )}
          />
        ),
        { status },
      )
      expect(screen.getByTestId('overview-problem-time')).toHaveTextContent('just now')
    } finally {
      vi.useRealTimers()
    }
  })

  it('list the newest with their level, source and first line, and why a denial was refused', async () => {
    const status = withDocuments(1)
    await renderInConsole(
      () => (
        <RecentProblems
          status={status}
          live="live"
          state={answered(
            state({
              logs: { entries: 120, errors: 1, warnings: 1, problems: 2 },
              problems: [
                {
                  cursor: 'e1.9',
                  time: '2026-10-12T04:06:00.000Z',
                  level: 'error',
                  kind: null,
                  source: 'functions[us-central1-fails]',
                  firstLine: "TypeError: cannot read 'id' of undefined",
                  refs: [],
                },
                {
                  cursor: 'e1.8',
                  time: '2026-10-12T04:05:00.000Z',
                  level: 'warn',
                  kind: 'rules.denied',
                  source: 'firestore',
                  firstLine: 'Rules denied get on users/u_2 for u_9',
                  refs: [
                    { kind: 'firestore.document', key: '(default)|users/u_2' },
                    { kind: 'firestore.decision', key: '(default)|req-7' },
                  ],
                },
              ],
            }),
          )}
        />
      ),
      { status },
    )
    const rows = screen.getAllByTestId('overview-problem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('error')
    expect(rows[0]).toHaveTextContent('fails')
    expect(rows[0]).toHaveTextContent("TypeError: cannot read 'id' of undefined")
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'See why' })).toHaveAttribute(
      'href',
      expect.stringContaining('decision=req-7'),
    )
    expect(screen.getByTestId('overview-problems-total')).toHaveTextContent(
      '2 problems since the engine started',
    )
    expect(screen.queryByTestId('overview-live-notice')).not.toBeInTheDocument()
    // Each row opens its line in Logs; "Open logs" opens every problem.
    const opens = screen.getAllByTestId('overview-problem-open')
    expect(opens).toHaveLength(2)
    expect(opens[0]).toHaveAttribute('href', expect.stringContaining('/logs?entry=e1.9'))
    expect(opens[1]).toHaveAttribute('href', expect.stringContaining('/logs?entry=e1.8'))
    expect(screen.getByTestId('overview-open-logs')).toHaveAttribute(
      'href',
      expect.stringContaining('/logs?q=is%3Aproblem'),
    )
  })
})

it('says when the engine stopped keeping the recent problems current', async () => {
  const status = withDocuments(1)
  await renderInConsole(
    () => <RecentProblems status={status} state={answered(state())} live="ended" />,
    { status },
  )
  expect(screen.getByTestId('overview-live-notice')).toHaveAttribute('data-state', 'ended')
})

describe('connect your app', () => {
  it('prints the web snippet for this engine, and hands a picked tab to the page', async () => {
    const user = userEvent.setup()
    const onParam = vi.fn()
    const status = withDocuments(1)
    await renderInConsole(
      () => (
        <ConnectSection status={status} engine={undefined} param={undefined} onParam={onParam} />
      ),
      { status },
    )
    const snippet = screen.getByTestId('overview-connect-snippet')
    expect(snippet).toHaveTextContent(
      "connectFirestoreEmulator(getFirestore(app), '127.0.0.1', 8080)",
    )
    expect(snippet).toHaveTextContent(
      "initializeApp({ projectId: 'demo-overview', apiKey: 'demo-api-key' })",
    )
    await user.click(screen.getByRole('tab', { name: 'Flutter' }))
    expect(onParam).toHaveBeenCalledWith('flutter')
  })

  it('prints the tab the address names, with the engine’s bucket', async () => {
    const status = withDocuments(1)
    await renderInConsole(
      () => <ConnectSection status={status} engine={undefined} param="env" onParam={() => {}} />,
      { status },
    )
    const snippet = screen.getByTestId('overview-connect-snippet')
    expect(snippet).toHaveTextContent('FIRESTORE_EMULATOR_HOST=127.0.0.1:8080')
    expect(snippet).toHaveTextContent('FIREBASE_EMULATOR_HUB=127.0.0.1:4400')
    expect(screen.getByTestId('overview-connect-note')).toHaveTextContent('emulators:exec')
  })
})

/** A suite job three seconds in. */
const job = (overrides: Partial<Job>): Job => ({
  id: 'job-1',
  kind: 'suite.clear',
  section: 'suite',
  title: 'Clear Firestore',
  total: 1596,
  done: 412,
  skipped: 0,
  errors: [],
  errorCount: 0,
  state: 'running',
  startedAt: new Date(Date.now() - 3_000).toISOString(),
  finishedAt: null,
  ...overrides,
})

/** The page's snapshot flow at rest: nothing prepared, nothing running. */
const view = (overrides: Partial<SnapshotView> = {}): SnapshotView => ({
  running: undefined,
  job: undefined,
  ready: undefined,
  taken: undefined,
  refusal: undefined,
  starting: false,
  start: vi.fn(async () => true),
  download: vi.fn(),
  file: { data: undefined },
  ...overrides,
})

describe('the data cards', () => {
  it('follow a running reset and hold back every control that would start another job', async () => {
    const status = withDocuments(1596)
    const running = job({})
    await renderInConsole(
      () => (
        <DataCards
          status={status}
          snapshot={view({ running, job: running })}
          onDialog={() => {}}
          onReset={() => {}}
        />
      ),
      { status },
    )
    expect(screen.getByTestId('overview-job')).toHaveTextContent(
      'Clear Firestore: 412 of 1,596 deleted',
    )
    // Kumo turns a disabled button's title into its tooltip: why it waits.
    expect(screen.getByTestId('overview-snapshot-download')).toBeDisabled()
    expect(screen.getByTestId('overview-snapshot-save')).toBeDisabled()
    expect(screen.getByTestId('overview-reset-firestore-open')).toBeDisabled()
  })

  it('offer a prepared snapshot for download, and open a reset for its row', async () => {
    const user = userEvent.setup()
    const status = withDocuments(1596)
    const onReset = vi.fn()
    const download = vi.fn()
    const done = job({
      id: 'job-2',
      kind: 'suite.snapshot',
      title: 'Prepare a snapshot',
      total: 1,
      done: 1,
      state: 'done',
    })
    await renderInConsole(
      () => (
        <DataCards
          status={status}
          snapshot={view({
            job: done,
            ready: { snapshot: '0123456789abcdef0123456789abcdef', files: 3, bytes: 2_355 },
            download,
          })}
          onDialog={() => {}}
          onReset={onReset}
        />
      ),
      { status },
    )
    expect(screen.getByTestId('overview-snapshot-ready')).toHaveTextContent(
      'Snapshot ready·3 files, 2.3 KB·Download',
    )
    await user.click(screen.getByTestId('overview-snapshot-ready-download'))
    expect(download).toHaveBeenCalledOnce()
    await user.click(screen.getByTestId('overview-reset-firestore-open'))
    expect(onReset).toHaveBeenCalledWith({ kind: 'section', id: 'firestore' })
  })
})
