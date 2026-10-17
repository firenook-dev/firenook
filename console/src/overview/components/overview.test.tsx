import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { Job } from '@/api/generated/Job'
import type { OverviewEngineDetails } from '@/api/generated/observe/OverviewEngineDetails'
import type { OverviewState } from '@/api/generated/observe/OverviewState'
import { statusQuery } from '@/api/queries'
import { renderInConsole } from '@/test/render'
import { sectionEntry, testStatus } from '@/test/status'
import { sectionCards, sharedHost, suiteHealth } from '../model'
import { createNoticeStore } from '../notices'
import type { SnapshotView } from '../snapshot'
import { DataCard } from './data-section'
import { EngineDetails } from './engine-details'
import { Notices } from './notices'
import { OverviewHeader } from './overview-header'
import { RecentProblems } from './problems'
import { ServiceTile } from './service-tile'

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
  problemsLogged: 0,
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

/** The Firestore tile, drawn from the status in the query cache as the page draws it. */
function LiveTile() {
  const status = useQuery(statusQuery).data
  const cards = status ? sectionCards(status, new Map()) : []
  const [card] = cards
  return card && status ? <ServiceTile card={card} host={sharedHost(cards)} tick={status} /> : null
}

describe('a section tile', () => {
  it('opens its section, and shows its port, its figures and nothing more while it runs', async () => {
    const status = withDocuments(1596)
    const cards = sectionCards(status, new Map())
    const [card] = cards
    if (!card) throw new Error('no card')
    await renderInConsole(
      () => <ServiceTile card={card} host={sharedHost(cards)} tick={status} />,
      { status },
    )
    const article = screen.getByTestId('overview-card-firestore')
    // The host is written once above the grid; the tile names the port, and copies the whole address.
    expect(within(article).getByTestId('overview-card-firestore-address')).toHaveTextContent(
      /^:8080$/,
    )
    expect(screen.getByTestId('overview-figure-firestore-documents')).toHaveTextContent('1,596')
    expect(screen.getByTestId('overview-figure-firestore-databases')).toHaveTextContent('1')
    expect(within(article).getByRole('link', { name: 'Firestore' })).toHaveAttribute(
      'href',
      '/firestore',
    )
    // Running is the dot alone; the word is there for a screen reader.
    expect(screen.getByTestId('overview-card-firestore-health')).toHaveAttribute(
      'data-tone',
      'success',
    )
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
    await renderInConsole(() => <ServiceTile card={card} host={undefined} tick={status} />, {
      status,
    })
    expect(screen.getByTestId('overview-card-firestore-holds')).toHaveTextContent(
      'Documents in every database, and the rules that guard them.',
    )
    expect(screen.queryByTestId('overview-card-firestore-figures')).not.toBeInTheDocument()
    // Without a shared host, the tile shows its whole address.
    expect(screen.getByTestId('overview-card-firestore-address')).toHaveTextContent(
      '127.0.0.1:8080',
    )
  })

  it('keeps an absent section’s place, with the engine’s reason, and opens its gate', async () => {
    const status = testStatus({
      projectId: 'demo-overview',
      services,
      sections: [
        sectionEntry('storage', {
          state: 'absent',
          reason: 'excluded-by-only',
          detail: 'This engine was started with --only firestore.',
        }),
      ],
    })
    const [card] = sectionCards(status, new Map())
    if (!card) throw new Error('no card')
    await renderInConsole(() => <ServiceTile card={card} host={undefined} tick={status} />, {
      status,
    })
    const article = screen.getByTestId('overview-card-storage')
    expect(article).toHaveAttribute('data-state', 'absent')
    expect(screen.getByTestId('overview-card-storage-health')).toHaveTextContent('Not running')
    expect(screen.getByTestId('overview-card-storage-detail')).toHaveTextContent(
      'This engine was started with --only firestore.',
    )
    expect(within(article).getByRole('link', { name: 'Storage' })).toHaveAttribute(
      'href',
      '/storage',
    )
    expect(screen.queryByTestId('overview-card-storage-address')).not.toBeInTheDocument()
  })

  it('flashes a figure that changed, and only once in a burst of changes', async () => {
    const view = await renderInConsole(() => <LiveTile />, { status: withDocuments(10) })
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
})

describe('the header', () => {
  it('says the whole suite in one line', async () => {
    const status = withDocuments(1)
    await renderInConsole(
      () => (
        <OverviewHeader status={status} health={suiteHealth(sectionCards(status, new Map()))} />
      ),
      { status },
    )
    expect(screen.getByTestId('overview-health')).toHaveTextContent('All 1 service running')
    expect(screen.getByTestId('overview-data')).toHaveTextContent(
      'In memory, gone when the engine stops',
    )
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
    // While Logs runs the bars are a control: a bar opens that minute's problems.
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
                problemsLogged: 1,
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
              problemsLogged: 2,
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

describe('the data card', () => {
  it('follows a running reset and holds back every control that would start another job', async () => {
    const status = withDocuments(1596)
    const running = job({})
    await renderInConsole(
      () => (
        <DataCard
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
    expect(await screen.findByTestId('overview-reset-open')).toBeDisabled()
  })

  it('follows a snapshot being saved on the engine’s machine in its Snapshot half, with no Cancel', async () => {
    const status = withDocuments(1596)
    const saving = job({
      kind: 'suite.export',
      title: "Save a snapshot to the project's export folder",
      total: 1,
      done: 0,
    })
    await renderInConsole(
      () => (
        <DataCard
          status={status}
          snapshot={view({ running: saving, job: saving })}
          onDialog={() => {}}
          onReset={() => {}}
        />
      ),
      { status },
    )
    const line = within(screen.getByTestId('overview-snapshot')).getByTestId('overview-job')
    expect(line).toHaveTextContent(/^Save a snapshot to the project's export folder… [\d.]+ s$/)
    // The hub's export is one command: it cannot be stopped once it runs.
    expect(screen.queryByTestId('overview-job-cancel')).toBeNull()
    expect(within(screen.getByTestId('overview-reset')).queryByTestId('overview-job')).toBeNull()
    expect(await screen.findByTestId('overview-reset-open')).toBeDisabled()
  })

  it('offers a prepared snapshot for download, and opens a reset from its menu', async () => {
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
        <DataCard
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
    // The menu's code follows the first paint; until then the same button stands in for it.
    await waitFor(
      () => expect(screen.getByTestId('overview-reset-open')).toHaveAttribute('aria-haspopup'),
      { timeout: 5000 },
    )
    await user.click(screen.getByTestId('overview-reset-open'))
    // Each section says what it holds; the reset itself is the dialog's.
    const firestore = await screen.findByTestId('overview-reset-firestore')
    expect(firestore).toHaveTextContent('1596 documents · 1 database')
    await user.click(firestore)
    expect(onReset).toHaveBeenCalledWith({ kind: 'section', id: 'firestore' })
  })
})

describe('the engine card', () => {
  /** The engine details before `/overview/engine` has answered: the data facts alone. */
  const unanswered = {
    data: undefined,
    isError: false,
  } as unknown as UseQueryResult<OverviewEngineDetails>
  const disk = testStatus({
    data: {
      mode: 'disk',
      stateDir: '/work/app/state',
      resumed: true,
      importedFrom: null,
      exportOnExit: '/work/app/export',
      durability: 'per-commit',
    },
  })

  it('says where the data lives and how writes reach the disk, and the rest under Show all', async () => {
    const user = userEvent.setup()
    await renderInConsole(() => <EngineDetails status={disk} details={unanswered} />, {
      status: disk,
    })
    expect(screen.getByTestId('engine-data')).toHaveTextContent('On disk·resumed/work/app/state')
    expect(screen.getByTestId('engine-writes')).toHaveTextContent('per-commit')
    expect(screen.queryByTestId('engine-export-on-exit')).toBeNull()
    await user.click(screen.getByTestId('overview-engine-all'))
    expect(screen.getByTestId('engine-export-on-exit')).toHaveTextContent('/work/app/export')
    expect(screen.getByTestId('overview-engine-all')).toHaveTextContent('Show less')
  })

  it('in memory, says the data is gone when the engine stops and has no writes to describe', async () => {
    const memory = testStatus()
    await renderInConsole(() => <EngineDetails status={memory} details={unanswered} />, {
      status: memory,
    })
    expect(screen.getByTestId('engine-data')).toHaveTextContent(
      'In memory(gone when the engine stops)',
    )
    expect(screen.queryByTestId('engine-writes')).toBeNull()
  })

  it('opens whole when the address names it', async () => {
    window.history.replaceState(null, '', '/#engine')
    try {
      await renderInConsole(() => <EngineDetails status={disk} details={unanswered} />, {
        status: disk,
      })
      expect(screen.getByTestId('overview-engine-details')).toHaveAttribute('data-all', 'true')
      expect(screen.getByTestId('engine-export-on-exit')).toBeInTheDocument()
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })
})
