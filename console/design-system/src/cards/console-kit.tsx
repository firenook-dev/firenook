// The section kit every console section is built from (foundation §11.3):
// the page's anatomy, the table's states, the inspector, JSON, the filter
// field, feeds, editors, the section and shell states, menus, facets, code
// blocks and masked values. Each card renders the real components under
// the console's providers — a query client holding an engine status and a
// router — so what a card shows is what a section page draws. A menu a
// card cannot hold a pointer over is opened through its own controlled
// prop, or drawn from the parts the component itself uses.

import {
  Button,
  Sidebar,
  Text,
  Toasty,
  TooltipProvider,
  cn,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  CodeIcon,
  CopyIcon,
  DatabaseIcon,
  DownloadSimpleIcon,
  EnvelopeSimpleIcon,
  FolderIcon,
  FunnelIcon,
  GaugeIcon,
  HardDrivesIcon,
  LightningIcon,
  ProhibitIcon,
  ScrollIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
  TrashIcon,
  UserIcon,
  UsersIcon,
} from '@phosphor-icons/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import {
  type CSSProperties,
  type ReactNode,
  createContext,
  use,
  useEffect,
  useRef,
  useState,
} from 'react'
import { ApiError } from '@/api/client'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { Job } from '@/api/generated/Job'
import { statusQuery } from '@/api/queries'
import { CodeBlock } from '@/components/console/code-block'
import { DataTable, type DataTableColumn } from '@/components/console/data-table'
import { EMPTY_CONNECT, EmptyState, NoMatch, QueryError } from '@/components/console/empty-state'
import { connectDialects } from '@/lib/connect'
import { FacetList } from '@/components/console/facet-list'
import { FeedList, useFeedPending } from '@/components/console/feed-list'
import { Completion } from '@/components/console/completions'
import { DangerConfirmBody } from '@/components/console/danger-confirm'
import {
  FilterField,
  type FilterFieldSpec,
  staticCompletions,
} from '@/components/console/filter-field'
import { storageKeyFor } from '@/components/console/inspector-width'
import {
  Inspector,
  InspectorFooter,
  InspectorSection,
  InspectorTitle,
  useInspectorRoom,
} from '@/components/console/inspector'
import { JsonTree } from '@/components/console/json-tree'
import { JsonView } from '@/components/console/json-view'
import { KeyValueEditor, type KeyValueRow } from '@/components/console/key-value-editor'
import { KeyValueList } from '@/components/console/key-value-list'
import { LiveNotice, liveNoticeText } from '@/components/console/live-notice'
import {
  LIVE_BADGE,
  LiveBadgeFace,
  type LiveTrouble,
  liveTrouble,
} from '@/components/shell/live-badge'
import { LogLine, type LogLineLevel } from '@/components/console/log-line'
import { MaskedValue } from '@/components/console/masked-value'
import { MatchCount } from '@/components/console/match-count'
import { PanelFilter, PanelHeader } from '@/components/console/panel'
import { PanelTree, type PanelTreeNode } from '@/components/console/panel-tree'
import { PauseButton } from '@/components/console/pause-button'
import { PayloadView } from '@/components/console/payload-view'
import { RequiresNotice } from '@/components/console/requires-notice'
import { type RowMenuItem, RowMenuButton } from '@/components/console/row-menu'
import { ScopeSelect } from '@/components/console/scope-select'
import { SectionBanner } from '@/components/console/section-banner'
import { ServiceNotRunning, ServiceStarting } from '@/components/console/section-gate'
import { SectionBody } from '@/components/console/section-page'
import { SelectionBar } from '@/components/console/selection-bar'
import { ShellBanners } from '@/components/console/shell-banners'
import { TableFooter } from '@/components/console/table-footer'
import {
  SectionToolbar,
  ToolbarDivider,
  ToolbarField,
  ToolbarRow,
} from '@/components/console/toolbar'
import { CountBadge, NavIconWithDot, PanelTitle } from '@/components/kit'
import { connectSnippet } from '@/lib/connect'
import { contextAt } from '@/lib/filter'
import { createFeedStore } from '@/lib/live/feed-store'
import { sectionById } from '@/lib/services'
import { sectionEntry, testStatus } from '@/test/status'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

// ---- the engine the cards stand in front of -----------------------------

const PROJECT = 'demo-shop'
const SERVICES = [
  ['firestore', 8080],
  ['auth', 9099],
  ['storage', 9199],
  ['functions', 5001],
  ['pubsub', 8085],
  ['hub', 4400],
] as const

/** An engine running everything, nothing paused, nobody using another project. */
const STATUS: ConsoleStatus = testStatus({
  projectId: PROJECT,
  engine: { name: 'Firenook', version: '0.2.0', revision: null, consoleBuild: 'design-system' },
  services: SERVICES.map(([name, port]) => ({
    name,
    host: '127.0.0.1',
    port,
    listening: true,
    pid: null,
  })),
  sections: ['firestore', 'auth', 'storage', 'functions', 'pubsub'].map((id) => sectionEntry(id)),
})

/** What the card's router draws: the card, handed down through context. */
const CardContent = createContext<ReactNode>(null)

function CardRoot() {
  return <>{use(CardContent)}</>
}

/**
 * The console's providers around a card: the engine's status already in
 * the query client (nothing is fetched), a router for links and search
 * params, and tooltips.
 */
function Kit({ status = STATUS, children }: { status?: ConsoleStatus; children: ReactNode }) {
  const [client] = useState(() => {
    const created = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    created.setQueryData(statusQuery.queryKey, status)
    return created
  })
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: CardRoot }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    }),
  )
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CardContent value={children}>
          <RouterProvider router={router} />
        </CardContent>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

/** A piece of a page at its real size: a bordered box of a fixed height. */
function Frame({
  height,
  className,
  children,
}: {
  /** Fixed for a list or a page piece that fills what it is given; content height otherwise. */
  height?: number
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'relative flex min-w-0 flex-col overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line',
        className,
      )}
      style={height === undefined ? undefined : { height }}
    >
      {children}
    </div>
  )
}

/** A sample with the state it shows named above it. */
function Sample({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-2">
      <Text variant="secondary" size="sm">
        {label}
      </Text>
      {children}
    </div>
  )
}

const noop = () => {}

// ---- a users list, the shape most sections are -------------------------

interface User {
  uid: string
  email: string
  provider: string
  created: string
  logins: number
  disabled: boolean
}

const NAMES = ['ada', 'grace', 'linus', 'margaret', 'alan', 'barbara', 'edsger', 'frances']
const PROVIDERS = ['password', 'google.com', 'phone', 'anonymous']
const NOW = Date.parse('2026-10-12T06:00:00Z')

const USERS: User[] = Array.from({ length: 240 }, (_, index) => ({
  uid: `u_${(index * 7919 + 4099).toString(36).padStart(5, '0')}`,
  email: `${NAMES[index % NAMES.length]}${index === 0 ? '' : index}@example.test`,
  provider: PROVIDERS[index % PROVIDERS.length] ?? 'password',
  created: new Date(NOW - (index + 1) * 3_600_000 * 7).toISOString(),
  logins: (index * 37) % 400,
  disabled: index % 13 === 5,
}))

function ago(iso: string): string {
  const hours = Math.round((NOW - Date.parse(iso)) / 3_600_000)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

const COLUMNS: DataTableColumn<User>[] = [
  { id: 'uid', header: 'uid', width: 120, pinned: true, cell: (row) => row.uid },
  {
    id: 'email',
    header: 'Email',
    width: 220,
    sortable: true,
    cell: (row) => row.email,
    copy: (row) => row.email,
  },
  { id: 'provider', header: 'Provider', width: 120, cell: (row) => row.provider },
  {
    id: 'created',
    header: 'Created',
    width: 110,
    sortable: true,
    cell: (row) => <span className="font-sans">{ago(row.created)}</span>,
  },
  {
    id: 'logins',
    header: 'Sign-ins',
    width: 90,
    align: 'end',
    cell: (row) => row.logins.toLocaleString('en-US'),
  },
  {
    id: 'state',
    header: 'State',
    width: 96,
    cell: (row) =>
      row.disabled ? (
        <span className="font-sans text-kumo-danger">Disabled</span>
      ) : (
        <span className="font-sans text-kumo-subtle">Active</span>
      ),
  },
]

const NOUN = { one: 'user', other: 'users' }
const TOTAL = { count: 240, exact: true }

const MENU = (user: User): RowMenuItem[] => [
  { id: 'open', label: 'Open', icon: SidebarSimpleIcon, shortcut: 'Enter', run: noop },
  { id: 'copy', label: 'Copy uid', icon: CopyIcon, shortcut: 'Mod+c', run: noop },
  { id: 'as', label: 'View the data as this user', icon: ShieldCheckIcon, run: noop },
  {
    id: 'disable',
    label: user.disabled ? 'Enable' : 'Disable…',
    icon: ProhibitIcon,
    disabled: user.provider === 'anonymous' ? 'Anonymous users cannot be disabled.' : undefined,
    run: noop,
  },
  { id: 'delete', label: 'Delete…', icon: TrashIcon, danger: true, shortcut: 'Delete', run: noop },
]

const FIELDS: FilterFieldSpec[] = [
  {
    key: 'provider',
    aliases: ['p'],
    kind: 'enum',
    help: 'Sign-in provider',
    values: ['anonymous', 'google.com', 'password', 'phone'],
    valueAliases: { google: 'google.com' },
  },
  {
    key: 'is',
    kind: 'enum',
    help: 'disabled, verified, anonymous',
    values: ['anonymous', 'disabled', 'verified'],
  },
  { key: 'email', kind: 'text', help: 'Email address, or part of one' },
  { key: 'created', kind: 'time', help: 'When the account was made: -7d, 2026-10-01' },
  { key: 'logins', kind: 'number', help: 'How many times the user signed in' },
]

function UsersTable({
  rows = USERS,
  openKey,
  flashes,
  checked,
  loading,
  empty,
  newAbove,
  memoryKey,
  footer,
  testId,
}: {
  footer?: ReactNode
  rows?: readonly User[]
  openKey?: string
  flashes?: ReadonlyMap<string, 'created' | 'updated' | 'deleted'>
  checked?: ReadonlySet<string>
  loading?: boolean
  empty?: ReactNode
  newAbove?: number
  memoryKey: string
  testId?: string
}) {
  return (
    <DataTable<User>
      ariaLabel="Users"
      rows={rows}
      rowKey={(row) => row.uid}
      columns={COLUMNS}
      memoryKey={memoryKey}
      keyboard="focus"
      sort={{ column: 'created', direction: 'desc' }}
      onSortChange={noop}
      selection={{ checked: checked ?? new Set(), everything: false, onChange: noop }}
      openKey={openKey}
      onOpen={noop}
      flashes={flashes}
      newAbove={newAbove}
      total={TOTAL}
      hasMore={false}
      rowMenu={MENU}
      loading={loading}
      empty={empty ?? <p />}
      footer={
        footer ??
        (rows.length > 0 ? (
          <TableFooter loaded={rows.length} total={TOTAL} hasMore={false} noun={NOUN} />
        ) : undefined)
      }
      testId={testId}
    />
  )
}

// Inspector widths for the cards, as a person who dragged them would have
// left them: the anatomy at 716 and 350, the page at 420.
for (const [key, width] of [
  ['ds.anatomy', 420],
  ['ds.wide', 716],
  ['ds.narrow', 340],
] as const) {
  try {
    localStorage.setItem(storageKeyFor(key), String(width))
  } catch {
    // A preview without storage shows the default width.
  }
}

/** The footer as an inspector draws it: below 350 px, Code keeps its glyph and gives up its word. */
function UserFooter() {
  const { labels } = useInspectorRoom()
  return (
    <InspectorFooter
      tools={
        labels ? (
          <Button variant="ghost" size="sm" icon={<CodeIcon />}>
            Code
          </Button>
        ) : (
          <Button variant="ghost" size="sm" shape="square" icon={<CodeIcon />} aria-label="Code" />
        )
      }
      danger={
        <Button variant="ghost" size="sm" icon={<TrashIcon className="text-kumo-danger" />}>
          <span className="text-kumo-danger">Delete</span>
        </Button>
      }
      primary={
        <Button variant="primary" size="sm" disabled>
          Save
        </Button>
      }
    />
  )
}

function UserInspector({ user, widthKey }: { user: User; widthKey: string }) {
  return (
    <Inspector
      widthKey={widthKey}
      title={<InspectorTitle value={user.uid} />}
      meta={<span className="text-[12px] text-kumo-subtle">{ago(user.created)}</span>}
      actions={
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<ArrowSquareOutIcon />}
          aria-label="Open the user's documents"
        />
      }
      onClose={noop}
      closeLabel="Close the user"
      noun="user"
      onPrev={noop}
      onNext={noop}
      tabs={{
        items: [
          { value: 'details', label: 'Details' },
          { value: 'claims', label: 'Claims', count: 2 },
          { value: 'activity', label: 'Activity', count: 14 },
        ],
        value: 'details',
        onChange: noop,
      }}
      footer={<UserFooter />}
      testId={`inspector-${widthKey}`}
    >
      <div className="px-5 py-3">
        <KeyValueList
          items={[
            { label: 'uid', value: user.uid, copy: user.uid },
            { label: 'Email', value: user.email, copy: user.email },
            { label: 'Provider', value: user.provider },
            {
              label: 'Created',
              value: ago(user.created),
              mono: false,
              hint: new Date(user.created).toUTCString(),
            },
            { label: 'Password hash', value: 'c2NyeXB0OjE2Mzg0Ojg6MTpZbFNkd3', masked: true },
          ]}
        />
      </div>
      <InspectorSection title="Custom claims" count={2}>
        <KeyValueList
          items={[
            { label: 'admin', value: 'true' },
            { label: 'plan', value: '"pro"' },
          ]}
        />
      </InspectorSection>
      <InspectorSection title="Sessions" count={0} />
      <InspectorSection title="Linked providers" count={0} />
    </Inspector>
  )
}

// ---- section-anatomy ----------------------------------------------------

const TENANTS: PanelTreeNode[] = [
  {
    id: 'default',
    label: '(default)',
    icon: UsersIcon,
    count: 240,
    children: [
      { id: 'acme', label: 'acme', icon: FolderIcon, count: 120 },
      { id: 'globex', label: 'globex', icon: FolderIcon, count: 12, tone: 'warning' },
      { id: 'initech', label: 'initech', icon: FolderIcon, count: 3, tone: 'danger' },
    ],
  },
  { id: 'staging', label: 'staging', icon: UsersIcon, count: 9 },
]

function Callout({
  number,
  title,
  children,
}: {
  number: number
  title: string
  children: ReactNode
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-kumo-tint text-[11px] font-medium text-kumo-default tabular-nums">
        {number}
      </span>
      <span className="grid content-start gap-0.5">
        <span className="text-[13px] font-medium text-kumo-default">{title}</span>
        <span className="text-[13px] text-kumo-subtle">{children}</span>
      </span>
    </li>
  )
}

function SectionAnatomy() {
  const [q, setQ] = useState('provider:google -is:disabled')
  const [filter, setFilter] = useState('')
  const open = USERS[3]!
  return (
    <Kit>
      <Stack>
        <Frame height={620}>
          <div className="flex min-h-0 flex-1">
            <aside className="flex w-[248px] shrink-0 flex-col border-r border-kumo-line">
              <PanelHeader
                filter={
                  <PanelFilter value={filter} onChange={setFilter} placeholder="Filter tenants" />
                }
              >
                <ScopeSelect
                  label="Tenant"
                  value="default"
                  items={[
                    { value: 'default', label: '(default)', detail: '240' },
                    { value: 'acme', detail: '120' },
                  ]}
                  onChange={noop}
                  className="flex-1"
                />
              </PanelHeader>
              <PanelTree
                nodes={TENANTS}
                current="default"
                expanded={new Set(['default'])}
                onToggle={noop}
                onOpen={noop}
                filter={filter}
                ariaLabel="Tenants"
              />
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              <SectionToolbar>
                <ToolbarRow>
                  <ToolbarField icon={<UserIcon size={14} className="mx-2 text-kumo-subtle" />}>
                    <span className="truncate font-mono text-[12px]">
                      projects/{PROJECT}/tenants/(default)/users
                    </span>
                  </ToolbarField>
                  <ToolbarDivider />
                  <Button variant="ghost" size="sm" icon={<ShieldCheckIcon />}>
                    As Admin
                  </Button>
                  <ToolbarDivider />
                  <Button variant="primary" size="sm">
                    New user
                  </Button>
                </ToolbarRow>
                <ToolbarRow variant="line">
                  <FilterField
                    value={q}
                    onChange={setQ}
                    fields={FIELDS}
                    placeholder="Filter users — provider:google -is:disabled ada"
                    ariaLabel="Filter users"
                  />
                  <MatchCount total={{ count: 61, exact: true }} noun={NOUN} widest="0,000,000" />
                </ToolbarRow>
              </SectionToolbar>
              <SectionBody>
                <UsersTable openKey={open.uid} memoryKey="ds.anatomy" />
                <UserInspector user={open} widthKey="ds.anatomy" />
              </SectionBody>
            </div>
          </div>
        </Frame>
        <ol className="grid grid-cols-2 gap-x-10 gap-y-3">
          <Callout number={1} title="The panel">
            PanelHeader holds the scope (ScopeSelect) and the panel's filter; PanelTree lists what
            the scope holds, counts on the right, tones on what needs a look.
          </Callout>
          <Callout number={2} title="Row one, the scope">
            Where the page is (a ToolbarField the reader can copy), who it is seen as, and the
            primary action at the right end.
          </Callout>
          <Callout number={3} title="Row two, the query line">
            FilterField, then MatchCount. Ticked rows lay the SelectionBar over this row; nothing
            below moves.
          </Callout>
          <Callout number={4} title="The table">
            DataTable: a pinned key column, sortable headers where an index is, a ⋯ per row, the
            footer saying how much is loaded.
          </Callout>
          <Callout number={5} title="The inspector">
            Beside the table from xl up, over it below: title in the data face, previous and next,
            tabs with counts, facts, sections, the footer's tools, danger and primary.
          </Callout>
          <Callout number={6} title="Banners">
            Suite facts sit above the toolbar (ShellBanners); a page's own strip (SectionBanner)
            under it.
          </Callout>
        </ol>
      </Stack>
    </Kit>
  )
}

// ---- data-table-states --------------------------------------------------

/** Scrolls a table down a little once it is drawn, as a reader who has left the top. */
function ScrolledAway({ testId, children }: { testId: string; children: ReactNode }) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const scroller = document.querySelector<HTMLElement>(`[data-testid="${testId}-scroll"]`)
      if (scroller) scroller.scrollTop = 160
    }, 50)
    return () => window.clearTimeout(timer)
  }, [testId])
  return <>{children}</>
}

function TableStates() {
  const ticked = new Set(USERS.slice(1, 4).map((user) => user.uid))
  return (
    <Kit>
      <div className="grid grid-cols-2 gap-6">
        <Sample label="Loading: the header over skeleton rows, only after 150 ms">
          <Frame height={300}>
            <UsersTable rows={[]} loading memoryKey="ds.states.loading" />
          </Frame>
        </Sample>
        <Sample label="None yet: how things get here from the app, then the console's way in">
          <Frame height={300}>
            <EmptyState
              icon={UsersIcon}
              title="No users yet"
              description="Users appear when your app signs someone up."
              actions={<Button variant="primary">Add user</Button>}
            />
          </Frame>
        </Sample>
        <Sample label="No match: the filter named in the data face, and the way out">
          <Frame height={300}>
            <NoMatch filter="provider:google -is:disabled ada" onClear={noop} noun="users" />
          </Frame>
        </Sample>
        <Sample label="An error: the engine's message as the title, its fix under it">
          <Frame height={300}>
            <QueryError
              error={
                new ApiError(
                  400,
                  'There is no filter key called "plan".',
                  'invalid-argument',
                  'Use provider, is, email, created or logins; quote the text to search for it.',
                )
              }
              onRetry={noop}
            />
          </Frame>
        </Sample>
        <Sample label="Ticked rows: the selection bar laid over row two">
          <Frame height={300}>
            <SectionToolbar>
              <ToolbarRow
                variant="line"
                overlay={
                  <SelectionBar
                    count={3}
                    total={TOTAL}
                    everything={false}
                    filtered
                    noun={NOUN}
                    onSelectEverything={noop}
                    onClear={noop}
                    actions={
                      <>
                        <Button variant="ghost" size="sm" icon={<ProhibitIcon />}>
                          Disable
                        </Button>
                        <span className="ml-auto shrink-0 pl-3">
                          <Button variant="secondary-destructive" size="sm" icon={<TrashIcon />}>
                            Delete 3
                          </Button>
                        </span>
                      </>
                    }
                  />
                }
              >
                <span className="h-8" />
              </ToolbarRow>
            </SectionToolbar>
            <UsersTable checked={ticked} memoryKey="ds.states.ticked" />
          </Frame>
        </Sample>
        <Sample label="Fifty pages down: the window's place in the list, hidden columns, Export">
          <Frame height={300}>
            <UsersTable
              memoryKey="ds.states.window"
              footer={
                <TableFooter
                  loaded={2_000}
                  rowOffset={3_100}
                  total={{ count: 104_212, exact: true }}
                  hasMore
                  hiddenColumns={2}
                  onShowAll={noop}
                  noun={NOUN}
                  actions={
                    <Button variant="ghost" size="xs" icon={<DownloadSimpleIcon />}>
                      Export
                    </Button>
                  }
                />
              }
            />
          </Frame>
        </Sample>
        <Sample label="Rows created above the reader: counted, and one press away">
          <Frame height={300}>
            <ScrolledAway testId="ds-new-above">
              <UsersTable newAbove={12} memoryKey="ds.states.new" testId="ds-new-above" />
            </ScrolledAway>
          </Frame>
        </Sample>
        <Sample label="Live: a created, an updated and a deleted row settle from their tint">
          {/* Held at the flash's first frame: a card cannot show 1.6 s passing. */}
          <Frame height={300} className="ds-hold-flash">
            <UsersTable
              flashes={
                new Map([
                  [USERS[0]!.uid, 'created' as const],
                  [USERS[2]!.uid, 'updated' as const],
                  [USERS[4]!.uid, 'deleted' as const],
                ])
              }
              memoryKey="ds.states.flash"
            />
          </Frame>
        </Sample>
      </div>
    </Kit>
  )
}

// ---- inspector-anatomy --------------------------------------------------

function InspectorAnatomy() {
  const user = USERS[3]!
  return (
    <Kit>
      <Stack>
        <Section
          title="At 716 px"
          note="Title in the data face, copyable; meta beside it; an action; previous and next with the row's noun; tabs with counts; facts on one alignment; an empty section is its heading alone; the footer's tools, danger and primary."
        >
          <Frame height={500} className="items-end bg-kumo-canvas">
            <UserInspector user={user} widthKey="ds.wide" />
          </Frame>
        </Section>
        <Section
          title="At 340 px, just under the rule"
          note="Below 350 px the least important control, Code, keeps its glyph and gives up its word; values wrap rather than being cut."
        >
          <Frame height={500} className="items-end bg-kumo-canvas">
            <UserInspector user={user} widthKey="ds.narrow" />
          </Frame>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- json-tree -----------------------------------------------------------

const ORDER = {
  id: 'o_20251',
  status: 'paid',
  total: 42.5,
  placed: '2026-10-12T06:02:11Z',
  lines: [
    { sku: 'mug-ember', qty: 2 },
    { sku: 'tote-plain', qty: 1 },
  ],
  shipped: null,
}

const DELIVERY = {
  customer: 'users/u_k65eq',
  note: 'Leave the parcel with the neighbour at number 14 if nobody answers; the side gate is open on weekdays until six, and the code for the bike shed is written on the inside of the meter cupboard door, which is never locked. Ring twice.',
  payment: { card: 'visa', last4: '4242', token: 'tok_test_51Hx9yQ2eZvKYlo2C8nKp' },
}

const BATCH = { items: Array.from({ length: 620 }, (_, index) => `sku_${index}`) }

/** Scrolls a tree to its end once it is drawn, where a long container's paging sits. */
function AtTheEnd({ testId, children }: { testId: string; children: ReactNode }) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const tree = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      if (tree) tree.scrollTop = tree.scrollHeight
    }, 50)
    return () => window.clearTimeout(timer)
  }, [testId])
  return <>{children}</>
}

function JsonCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="A JSON value"
          note="The tree to fold and the raw text; search says “2 of 5” and steps with ↑ ↓; Copy JSON copies the text as it came."
        >
          <Frame height={250}>
            <JsonView value={ORDER} testId="ds-json" />
          </Frame>
        </Section>
        <Section
          title="Secrets, references and long strings"
          note="A secret is masked and copied only once shown; a reference another section shows is a link into it; a long string is cut, the rest a press away."
        >
          <Frame height={200}>
            <JsonTree
              value={DELIVERY}
              defaultDepth={2}
              height="fill"
              mask={(path) => path.at(-1) === 'token'}
              refs={(path, value) =>
                path.at(-1) === 'customer' && typeof value === 'string'
                  ? { kind: 'firestore.document', key: `(default)|${value}` }
                  : undefined
              }
              ariaLabel="A delivery"
            />
          </Frame>
        </Section>
        <div className="grid grid-cols-2 gap-6">
          <Sample label="Search: every hit's containers open, the current hit marked">
            <Frame height={150}>
              <JsonTree
                value={{
                  customer: { name: 'ada', email: 'ada@example.test' },
                  note: 'ada asked for gift wrap',
                }}
                search="ada"
                activeHit={1}
                height="fill"
                ariaLabel="Search hits"
              />
            </Frame>
          </Sample>
          <Sample label="620 children: the first 500, then the rest a press away">
            <Frame height={150}>
              <AtTheEnd testId="ds-json-paged">
                <JsonTree
                  value={BATCH}
                  defaultDepth={2}
                  height="fill"
                  ariaLabel="A long array"
                  testId="ds-json-paged"
                />
              </AtTheEnd>
            </Frame>
          </Sample>
          <Sample label="A text payload">
            <Frame height={150}>
              <PayloadView
                text={'order o_20251 paid\ncustomer ada@example.test\ntotal 42.50 EUR'}
                contentType="text/plain"
              />
            </Frame>
          </Sample>
          <Sample label="Bytes: the first 4 KB in hex, and Download">
            <Frame height={150}>
              <PayloadView
                base64="iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz"
                contentType="image/png"
                filename="avatar.png"
              />
            </Frame>
          </Sample>
        </div>
      </Stack>
    </Kit>
  )
}

// ---- filter-field --------------------------------------------------------

function CompletionPanel({ text, label }: { text: string; label: string }) {
  // What the field itself would offer with the caret at the end of `text`.
  const items = staticCompletions(contextAt(text, text.length, { fields: FIELDS }), FIELDS)
  return (
    <Sample label={label}>
      <div className="grid gap-1">
        <span className="w-fit rounded-md bg-kumo-control px-2 py-1 font-mono text-[12px] text-kumo-default ring ring-kumo-line">
          {text}
          <span className="ml-px inline-block h-3.5 w-px translate-y-0.5 bg-kumo-default" />
        </span>
        <div className="w-[420px] rounded-lg bg-kumo-elevated shadow-md ring ring-kumo-line">
          <ul className="max-h-56 overflow-auto p-1">
            {items.map((item) => (
              <Completion
                key={item.label}
                label={item.label}
                detail={item.detail ?? ''}
                onPick={noop}
              />
            ))}
          </ul>
        </div>
      </div>
    </Sample>
  )
}

function FilterCard() {
  const [good, setGood] = useState('provider:google -is:disabled created:>-7d ada')
  const [bad, setBad] = useState('provider:google plan:pro')
  return (
    <Kit>
      <Stack>
        <Section
          title="Tokens on a tinted ground"
          note="Each key:value item, negated or not, is painted behind the text as it is typed; words are left plain. The field is the URL's q."
        >
          <Frame>
            <ToolbarRow variant="line">
              <FilterField
                value={good}
                onChange={setGood}
                fields={FIELDS}
                placeholder="Filter users — provider:google -is:disabled ada"
                ariaLabel="Filter users"
              />
              <MatchCount total={{ count: 18, exact: true }} noun={NOUN} widest="0,000,000" />
            </ToolbarRow>
          </Frame>
        </Section>
        <Section
          title="An invalid filter"
          note="The ring stays red at rest, the offending span is underlined and the message says what to write; the table shows the error, never the last good rows."
        >
          <Frame>
            <ToolbarRow variant="line">
              <FilterField
                value={bad}
                onChange={setBad}
                fields={FIELDS}
                placeholder="Filter users"
                ariaLabel="Filter users with a mistake"
              />
            </ToolbarRow>
          </Frame>
        </Section>
        <div className="grid grid-cols-2 gap-6">
          <CompletionPanel
            text="provider:google "
            label="At the start of an item: the keys, each with its help line"
          />
          <CompletionPanel text="created:>" label="After a key: the values it takes" />
        </div>
      </Stack>
    </Kit>
  )
}

// ---- feeds ---------------------------------------------------------------

interface Line {
  id: string
  at: string
  level: LogLineLevel
  source: string
  message: string
}

const SOURCES = ['functions', 'auth', 'storage', 'pubsub']

function lines(from: number, count: number): Line[] {
  return Array.from({ length: count }, (_, offset) => {
    const serial = from + offset
    const level: LogLineLevel = serial % 17 === 0 ? 'error' : serial % 7 === 0 ? 'warn' : 'info'
    return {
      id: `l${serial}`,
      at: new Date(NOW + serial * 137).toISOString(),
      level,
      source: SOURCES[serial % SOURCES.length] ?? 'functions',
      message:
        level === 'error'
          ? `TypeError: Cannot read properties of undefined (reading 'uid') at greet (index.js:${serial % 90}:12)`
          : level === 'warn'
            ? `greet: price list is ${serial % 5} days old; using it anyway`
            : `greet: hello ${NAMES[serial % NAMES.length]} (${serial})`,
    }
  })
}

/** A feed's line as every log in the console draws it: the shared LogLine. */
function LineRow({ item }: { item: Line }) {
  return (
    <LogLine
      time={item.at}
      level={item.level}
      source={item.source}
      message={item.message}
      className="min-w-0 flex-1"
    />
  )
}

/** The columns over the lines, on LogLine's own template. */
const FEED_HEADER = (
  <div className="grid h-7 grid-cols-[104px_44px_var(--log-source-width,120px)_minmax(0,1fr)] items-center gap-x-2 px-3 font-mono text-[11px] text-kumo-subtle">
    <span>time</span>
    <span className="pl-2">level</span>
    <span>source</span>
    <span>message</span>
  </div>
)

/** A feed's store, filled once: what it held, then what arrived while paused. */
function useStore(
  build: (store: ReturnType<typeof createFeedStore<Line>>) => void,
  paused = false,
) {
  const [store] = useState(() => {
    const created = createFeedStore<Line>({
      max: 10_000,
      key: (item) => item.id,
      pausedMode: 'freeze',
    })
    build(created)
    if (paused) {
      created.pause()
      created.push(lines(900, 12))
    }
    return created
  })
  return store
}

function Feed({
  store,
  follow,
  expanded,
  selected,
  toolbar,
  height = 300,
  scrollTo,
}: {
  store: ReturnType<typeof createFeedStore<Line>>
  /** Puts this line in the middle of the list. */
  scrollTo?: string
  follow: boolean
  expanded?: ReadonlySet<string>
  selected?: string
  toolbar?: ReactNode
  height?: number
}) {
  return (
    <Frame height={height}>
      {toolbar}
      {/* The source column's width, for the header and every line alike. */}
      <div
        className="flex min-h-0 flex-1"
        style={{ '--log-source-width': '96px' } as CSSProperties}
      >
        <FeedList<Line>
          ariaLabel="Log lines"
          store={store}
          order="newest-last"
          rowHeight={24}
          rowKey={(item) => item.id}
          renderRow={(item) => <LineRow item={item} />}
          expanded={expanded}
          renderExpanded={(item) => (
            <pre className="mx-3 mb-2 overflow-auto rounded-md bg-kumo-control p-2 font-mono text-[11px] leading-4 text-kumo-default ring ring-kumo-line">
              {`${item.message}\n    at greet (functions/index.js:12:5)\n    at invoke (worker.js:88:20)\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)`}
            </pre>
          )}
          onToggleExpanded={noop}
          selectedKey={selected}
          onSelect={noop}
          follow={follow}
          onFollowChange={noop}
          scrollToKey={scrollTo === undefined ? undefined : { key: scrollTo, align: 'center' }}
          header={FEED_HEADER}
          empty={<p />}
        />
      </div>
    </Frame>
  )
}

function FeedToolbar({ paused, pending }: { paused: boolean; pending: number }) {
  return (
    <ToolbarRow variant="line">
      <ToolbarField icon={<FunnelIcon size={14} className="mx-2 text-kumo-subtle" />}>
        <span className="truncate font-mono text-[12px] text-kumo-default">
          level:warn function:greet
        </span>
      </ToolbarField>
      <PauseButton paused={paused} pending={pending} onChange={noop} />
    </ToolbarRow>
  )
}

function FeedCard() {
  const live = useStore((store) => store.push(lines(1, 400)))
  const paused = useStore((store) => store.push(lines(1, 400)), true)
  const kept = useStore((store) => {
    store.push(lines(1, 60))
    store.gap(3_120, 10_000)
    store.push(lines(3_200, 3))
  })
  const pending = useFeedPending(paused, true, (item) => item.id)
  return (
    <Kit>
      <Stack>
        <Section
          title="Following at the live edge"
          note="Newest last; the list keeps the newest line in view as lines arrive. One notification a frame, however many arrive."
        >
          <Feed store={live} follow toolbar={<FeedToolbar paused={false} pending={0} />} />
        </Section>
        <Section
          title="Paused"
          note="Scrolling up or pressing p pauses; what arrives is counted on the button and the pill, and the reader's place does not move."
        >
          <Feed store={paused} follow={false} toolbar={<FeedToolbar paused pending={pending} />} />
        </Section>
        <Section
          title="What the engine let go"
          note="A reset after the engine's ring moved on is one row, with how many entries were missed and how many it keeps."
        >
          <Feed store={kept} follow height={180} />
        </Section>
      </Stack>
    </Kit>
  )
}

function FeedGapsCard() {
  const store = useStore((created) => {
    created.push(lines(1, 12))
    created.gap(3_120, 10_000)
    created.push(lines(3_200, 6))
    created.marker({ kind: 'marker', key: 'restart', text: 'Engine restarted at 06:02:11' })
    created.push(lines(3_300, 20))
  }, true)
  const pending = useFeedPending(store, true, (item) => item.id)
  return (
    <Kit>
      <Stack>
        <Section
          title="A gap, a marker, an expanded line, paused"
          note="The gap row after a reset; a marker row for the engine's own news; a line opened to its stack trace (→ opens, ← shuts); the pill with what arrived meanwhile."
        >
          <Feed
            store={store}
            follow={false}
            expanded={new Set(['l3204'])}
            selected="l3204"
            scrollTo="l3204"
            height={420}
            toolbar={<FeedToolbar paused pending={pending} />}
          />
        </Section>
        <Section
          title="PauseButton"
          note="p pauses and resumes; its slot is as wide as its widest label, so the filter beside it never moves when the feed pauses or the count grows."
        >
          <div className="grid gap-3">
            <Frame>
              <FeedToolbar paused={false} pending={0} />
            </Frame>
            <Frame>
              <FeedToolbar paused pending={12} />
            </Frame>
          </div>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- key-value-editor ----------------------------------------------------

const HEADERS: KeyValueRow[] = [
  { id: 'h1', key: 'content-type', value: 'application/json', enabled: true },
  { id: 'h2', key: 'x-trace', value: 'abc123', enabled: true },
  { id: 'h3', key: 'x-debug', value: '1', enabled: false },
  { id: 'h4', key: 'x-trace', value: 'def456', enabled: true },
]

/** Presses the editor's Bulk edit once it is drawn, as a person would. */
function OpensBulk({ testId, children }: { testId: string; children: ReactNode }) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-testid="${testId}-bulk"]`)?.click()
    }, 30)
    return () => window.clearTimeout(timer)
  }, [testId])
  return <>{children}</>
}

function KeyValueCard() {
  const [rows, setRows] = useState(HEADERS)
  const [bulkRows, setBulkRows] = useState(HEADERS.slice(0, 3))
  return (
    <Kit>
      <Stack>
        <Section
          title="Rows"
          note="A switch keeps a row without sending it; a key given twice is said where it is; the last row adds the next."
        >
          <KeyValueEditor
            label="Headers"
            rows={rows}
            onChange={setRows}
            allowDisable
            keyPlaceholder="header"
            testId="ds-kv-rows"
          />
        </Section>
        <Section title="Bulk edit" note="One line a row; // keeps a row and turns it off.">
          <OpensBulk testId="ds-kv-bulk">
            <KeyValueEditor
              label="Headers"
              rows={bulkRows}
              onChange={setBulkRows}
              allowDisable
              testId="ds-kv-bulk"
            />
          </OpensBulk>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- section-gate --------------------------------------------------------

function GateCard() {
  const storage = sectionById('storage')!
  const functions = sectionById('functions')!
  return (
    <Kit>
      <div className="grid gap-6">
        <Sample label="Not configured: the firebase.json lines, and firenook init --adopt">
          <Frame>
            <ServiceNotRunning
              section={storage}
              status={sectionEntry('storage', {
                state: 'absent',
                reason: 'not-configured',
                detail: 'firebase.json does not configure Storage.',
                fixes: [
                  {
                    kind: 'firebase-json',
                    label: 'Add it to firebase.json',
                    text: '"emulators": { "storage": {} },\n"storage": { "rules": "storage.rules" }',
                  },
                  {
                    kind: 'command',
                    label: 'Or let Firenook add what is missing',
                    text: 'npx firenook init --adopt',
                  },
                ],
              })}
            />
          </Frame>
        </Sample>
        <div className="grid grid-cols-2 gap-6">
          <Sample label="Left out by --only: the developer's command with the name added">
            <Frame className="h-full">
              <ServiceNotRunning
                section={storage}
                status={sectionEntry('storage', {
                  state: 'absent',
                  reason: 'excluded-by-only',
                  detail: 'The engine was started with --only firestore,auth.',
                  fixes: [
                    {
                      kind: 'command',
                      label: 'Start it with Storage',
                      text: 'firenook emulators:start --only firestore,auth,storage',
                    },
                  ],
                })}
              />
            </Frame>
          </Sample>
          <Sample label="Starting: what it waits for; the page fills in by itself">
            <Frame className="h-full">
              <ServiceStarting
                section={functions}
                status={sectionEntry('functions', {
                  state: 'starting',
                  detail: 'Loading the default codebase (functions/).',
                })}
              />
            </Frame>
          </Sample>
        </div>
      </div>
    </Kit>
  )
}

// ---- nav-states ----------------------------------------------------------

function Nav({ open }: { open: boolean }) {
  return (
    <Sidebar.Provider contained defaultOpen={open} className="h-full min-h-0!">
      <Sidebar>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.Menu>
              <Sidebar.MenuButton icon={<NavIconWithDot icon={GaugeIcon} />}>
                Overview
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>
          <Sidebar.Group>
            <Sidebar.GroupLabel>Data</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton
                icon={<NavIconWithDot icon={DatabaseIcon} tone="danger" />}
                active
              >
                <span className="truncate">Firestore</span>
                <span className="ml-auto group-data-[state=collapsed]/sidebar:hidden">
                  <CountBadge count={1} tone="danger" label="1 rules file does not compile" />
                </span>
              </Sidebar.MenuButton>
              <Sidebar.MenuButton icon={<NavIconWithDot icon={UsersIcon} tone="attention" />}>
                <span className="truncate">Authentication</span>
                <span className="ml-auto group-data-[state=collapsed]/sidebar:hidden">
                  <CountBadge count={3} tone="attention" label="3 new codes and links" />
                </span>
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                icon={<NavIconWithDot icon={HardDrivesIcon} />}
                className="text-kumo-inactive"
              >
                Storage
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>
          <Sidebar.Group>
            <Sidebar.GroupLabel>Compute</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton icon={<NavIconWithDot icon={LightningIcon} tone="starting" />}>
                Functions
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                icon={<NavIconWithDot icon={EnvelopeSimpleIcon} tone="neutral" />}
              >
                <span className="truncate">Pub/Sub</span>
                <span className="ml-auto group-data-[state=collapsed]/sidebar:hidden">
                  <CountBadge count={1_204} tone="neutral" label="1,204 messages waiting" />
                </span>
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>
          <Sidebar.Group>
            <Sidebar.GroupLabel>Observe</Sidebar.GroupLabel>
            <Sidebar.Menu>
              <Sidebar.MenuButton icon={<NavIconWithDot icon={ScrollIcon} />}>
                Logs
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
      </Sidebar>
      <div className="flex-1 bg-kumo-canvas" />
    </Sidebar.Provider>
  )
}

function NavCard() {
  return (
    <TooltipProvider>
      <Stack>
        <div className="flex gap-6">
          <Sample label="Expanded">
            <div className="h-[420px] w-64 overflow-hidden rounded-lg ring ring-kumo-hairline">
              <Nav open />
            </div>
          </Sample>
          <Sample label="Collapsed: badges become dots">
            <div className="h-[420px] w-40 overflow-hidden rounded-lg ring ring-kumo-hairline">
              <Nav open={false} />
            </div>
          </Sample>
        </div>
        <ul className="grid gap-1.5 text-[13px] text-kumo-subtle">
          <li>
            <span className="text-kumo-default">Danger</span> — a red count: a rules file that does
            not compile.
          </li>
          <li>
            <span className="text-kumo-default">Attention</span> — a tinted count with a ring: new
            since you last looked.
          </li>
          <li>
            <span className="text-kumo-default">Gauge</span> — a quiet count of what is there now.
          </li>
          <li>
            <span className="text-kumo-default">Absent</span> dims the item;{' '}
            <span className="text-kumo-default">starting</span> pulses its dot, seen in both widths.
          </li>
        </ul>
      </Stack>
    </TooltipProvider>
  )
}

// ---- live-channel-states -------------------------------------------------

/** The top bar's live badge in one state, with what its tooltip says. */
function EngineFace({ trouble }: { trouble: LiveTrouble }) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-52 shrink-0">
        <span className={cn(LIVE_BADGE, 'w-fit')}>
          <LiveBadgeFace trouble={trouble} />
        </span>
      </span>
      <Text variant="secondary" size="sm">
        {trouble.why}
      </Text>
    </div>
  )
}

/** Each state the bar says, from the shell's own list. */
const LIVE_TROUBLES = (
  [
    ['reconnecting', false, false],
    ['offline', false, false],
    ['too-many', false, false],
    ['connecting', false, true],
    ['live', true, false],
  ] as const
).flatMap(([live, updated, unreachable]) => liveTrouble(live, updated, unreachable) ?? [])

/** The restart toast, in a box of its own so it is drawn where the card is. */
function RestartToastSample() {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  return (
    <div
      ref={setBox}
      className="relative h-44 overflow-hidden rounded-lg bg-kumo-canvas ring ring-kumo-hairline [contain:paint]"
    >
      <Toasty {...(box ? { container: box } : {})}>
        <RestartToast />
        <span />
      </Toasty>
    </div>
  )
}

function RestartToast() {
  const toasts = useKumoToastManager()
  const shown = useRef(false)
  // The manager's identity changes per render and StrictMode mounts twice:
  // show the toast exactly once.
  useEffect(() => {
    if (shown.current) return
    shown.current = true
    toasts.add({
      title: 'The engine restarted',
      description:
        'Everything on screen was reloaded. Selections were cleared; unsaved edits were kept.',
      variant: 'success',
      timeout: 0,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

/** LiveNotice as the toolbar draws it, with the sentence its tooltip says. */
function NoticeRow({
  status,
  what,
  message,
}: {
  status: 'ended' | 'refused'
  what: string
  message?: string
}) {
  return (
    <div className="flex items-center gap-4">
      <span className="flex w-48 shrink-0">
        <LiveNotice
          status={status}
          what={what}
          message={message}
          onRetry={noop}
          testId={`ds-live-${status}`}
        />
      </span>
      <Text variant="secondary" size="sm">
        {liveNoticeText(status, what, message)}
      </Text>
    </div>
  )
}

function LiveChannelCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="The live badge"
          note="One connection per browser. While it is live the top bar says nothing about it; when it is not, it says so once, there, and nowhere else on the page."
        >
          <div className="grid gap-3">
            {LIVE_TROUBLES.map((trouble) => (
              <EngineFace key={trouble.label} trouble={trouble} />
            ))}
          </div>
        </Section>
        <Section
          title="One subscription that ended"
          note="When the engine ends or refuses a page's subscription, the toolbar says so with Retry; it also comes back by itself."
        >
          <div className="grid gap-3">
            <NoticeRow status="ended" what="the users" />
            <NoticeRow
              status="refused"
              what="the log lines"
              message="The engine does not know the topic logs.entries."
            />
          </div>
        </Section>
        <Section
          title="After a restart"
          note="A new engine instance: every query reloads, selections are cleared, and the toast says so."
        >
          <RestartToastSample />
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- shell-banners -------------------------------------------------------

const PAUSED_STATUS: ConsoleStatus = {
  ...STATUS,
  backgroundTriggers: {
    enabled: false,
    since: '2026-10-12T06:02:11Z',
    dropped: [
      { service: 'firestore', count: 312 },
      { service: 'storage', count: 2 },
    ],
  },
  foreignProjects: [
    {
      projectId: 'my-prod',
      services: ['firestore'],
      firstSeen: '2026-10-12T06:04:00Z',
      requests: 18,
    },
  ],
}

/** How to fix, opened: the popover the banner's button shows, drawn where the card is. */
function HowToFix() {
  const snippet = (target: 'web' | 'admin-node' | 'env') =>
    connectSnippet(target, { services: ['firestore', 'hub'], status: PAUSED_STATUS })
  return (
    <div className="ml-auto grid w-[560px] gap-3 rounded-lg bg-kumo-base p-4 shadow-lg ring ring-kumo-line">
      <div className="grid gap-1">
        <PanelTitle>Point your app at {PROJECT}</PanelTitle>
        <p className="m-0 text-[13px] text-kumo-subtle">
          Firestore saw requests for my-prod. Initialize the app with this emulator&apos;s project
          id, or start server code with{' '}
          <span className="font-mono text-[0.9em]">GCLOUD_PROJECT={PROJECT}</span>.
        </p>
      </div>
      <CodeBlock
        dialects={[
          { id: 'web', label: 'Web', code: snippet('web'), language: 'js' },
          {
            id: 'admin-node',
            label: 'Admin (Node.js)',
            code: snippet('admin-node'),
            language: 'js',
          },
          { id: 'env', label: 'Environment', code: snippet('env'), language: 'dotenv' },
        ]}
      />
    </div>
  )
}

function BannersCard() {
  return (
    <Kit status={PAUSED_STATUS}>
      <Stack>
        <Section
          title="On a page that can show another project"
          note="Background triggers paused, with since when, what was dropped and Resume; an app that writes to another project id, with Show."
        >
          <Frame>
            <ShellBanners section="firestore" projectScope />
          </Frame>
        </Section>
        <Section
          title="On a page that cannot"
          note="The same project named, with How to fix: the connection snippet for this engine."
        >
          <Frame>
            <ShellBanners section="storage" projectScope={false} />
          </Frame>
          <HowToFix />
        </Section>
        <Section
          title="The engine was updated under the page"
          note="Only a reload fixes that, so the strip cannot be put away."
        >
          <Frame>
            <SectionBanner
              tone="info"
              testId="ds-banner-updated"
              action={
                <Button variant="secondary" size="xs">
                  Reload
                </Button>
              }
            >
              The engine was updated. Reload to get its console.
            </SectionBanner>
          </Frame>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- row-menu ------------------------------------------------------------

function RowMenuCard() {
  // An anonymous user: Disable is offered, and says why it cannot be used.
  const user = USERS[3]!
  return (
    <Kit>
      <Stack>
        <Section
          title="One menu, three ways in"
          note="Right-click on the row, Shift+F10 or the context-menu key, and the row's ⋯ open the same items; destructive last, a disabled item says why."
        >
          <div className="h-[300px]">
            <div className="flex h-8 items-center gap-3 rounded-md bg-kumo-tint px-3 font-mono text-[12px]">
              <span className="w-[120px]">{user.uid}</span>
              <span className="flex-1 truncate">{user.email}</span>
              <span className="w-16 font-sans text-kumo-subtle">{user.provider}</span>
              <RowMenuButton
                items={MENU(user)}
                label={`Actions for ${user.uid}`}
                open
                onOpenChange={noop}
              />
            </div>
          </div>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- facet-list ----------------------------------------------------------

function FacetCard() {
  const [q, setQ] = useState('level:error -service:auth')
  return (
    <Kit>
      <Stack>
        <Section
          title="Facets"
          note="Pressing writes the term into q; Only replaces the group's terms; Hide writes the negated term, drawn struck through."
        >
          <div className="w-[260px]">
            <FacetList
              value={q}
              onChange={setQ}
              groups={[
                {
                  label: 'Level',
                  facets: [
                    { term: 'level:error', label: 'Error', count: 12, tone: 'danger' },
                    { term: 'level:warn', label: 'Warning', count: 40, tone: 'warning' },
                    { term: 'level:info', label: 'Info', count: 1_820 },
                  ],
                },
                {
                  label: 'Service',
                  facets: [
                    { term: 'service:functions', label: 'functions', count: 1_204 },
                    { term: 'service:auth', label: 'auth', count: 88 },
                    { term: 'service:storage', label: 'storage', count: 16 },
                  ],
                },
              ]}
            />
          </div>
          <Text variant="secondary" size="sm">
            q = <span className="font-mono text-[12px] text-kumo-default">{q}</span>
          </Text>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- code-block ----------------------------------------------------------

function CodeCard() {
  return (
    <Kit>
      <Stack>
        <Sample label="A firebase.json snippet">
          <CodeBlock
            label="Add it to firebase.json"
            code={'"emulators": { "storage": {} },\n"storage": { "rules": "storage.rules" }'}
            language="json"
          />
        </Sample>
        <Sample label="A command">
          <CodeBlock
            label="Start it with Storage"
            code="firenook emulators:start --only firestore,auth,storage"
            language="shell"
          />
        </Sample>
        <Sample label="The connect snippet, for this engine's host, ports and project">
          <CodeBlock
            label="From your app"
            dialects={connectDialects(STATUS, { services: ['auth'], params: EMPTY_CONNECT })}
          />
        </Sample>
      </Stack>
    </Kit>
  )
}

// ---- requires-notice -----------------------------------------------------

const REQUIRES_STATUS: ConsoleStatus = {
  ...STATUS,
  sections: [
    sectionEntry('firestore'),
    sectionEntry('pubsub', {
      state: 'absent',
      reason: 'not-configured',
      detail: 'firebase.json does not configure Pub/Sub.',
      fixes: [
        {
          kind: 'firebase-json',
          label: 'Add it to firebase.json',
          text: '"emulators": { "pubsub": {} }',
        },
      ],
    }),
    sectionEntry('functions', { state: 'starting', detail: 'Loading the default codebase.' }),
  ],
}

function RequiresCard() {
  return (
    <Kit status={REQUIRES_STATUS}>
      <Stack>
        <Sample label="The section it needs is absent: why, and How to start it">
          <Frame height={44}>
            <RequiresNotice
              section="pubsub"
              for="Running a schedule now"
              testId="ds-requires-absent"
            />
          </Frame>
        </Sample>
        <Sample label="The section it needs is starting">
          <Frame>
            <RequiresNotice
              section="functions"
              for="Calling a function"
              testId="ds-requires-starting"
            />
          </Frame>
        </Sample>
      </Stack>
    </Kit>
  )
}

// ---- masked-value --------------------------------------------------------

/** Presses a masked value's eye once it is drawn, as a person would. */
function PressesReveal({ testId, children }: { testId: string; children: ReactNode }) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-testid="${testId}-reveal"]`)?.click()
    }, 30)
    return () => window.clearTimeout(timer)
  }, [testId])
  return <>{children}</>
}

const never = () => new Promise<string>(() => {})
const refused = () =>
  Promise.reject(new Error('The engine keeps this secret only while Functions run.'))

function MaskedCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="Masked values"
          note="Shown as dots with the length; never copied before they are revealed; an error is said in place."
        >
          <div className="grid gap-3">
            <MaskRow label="A password hash">
              <MaskedValue
                value="c2NyeXB0OjE2Mzg0Ojg6MTpZbFNkd3NhbHQ"
                label="Show the hash"
                copyable
              />
            </MaskRow>
            <MaskRow label="A secret, pending">
              <PressesReveal testId="ds-mask-pending">
                <MaskedValue
                  length={24}
                  reveal={never}
                  label="Show the secret"
                  testId="ds-mask-pending"
                />
              </PressesReveal>
            </MaskRow>
            <MaskRow label="Revealed">
              <MaskedValue
                value="sk_test_51Hx9yQ2eZvKYlo2C"
                revealed
                onRevealedChange={noop}
                label="Hide the secret"
                copyable
              />
            </MaskRow>
            <MaskRow label="Failed">
              <PressesReveal testId="ds-mask-failed">
                <MaskedValue
                  length={24}
                  reveal={refused}
                  label="Show the secret"
                  testId="ds-mask-failed"
                />
              </PressesReveal>
            </MaskRow>
          </div>
        </Section>
      </Stack>
    </Kit>
  )
}

function MaskRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
      <Text variant="secondary" size="sm">
        {label}
      </Text>
      <span className="font-mono text-[12px]">{children}</span>
    </div>
  )
}

// ---- registration --------------------------------------------------------

// ---- danger-confirm ------------------------------------------------------

const DELETED_TRIGGER = {
  functionId: 'us-central1-onUserDeleted',
  codebase: 'default',
  eventType: 'providers/firebase.auth/eventTypes/user.delete',
  kind: 'auth',
}
const OBJECT_TRIGGER = {
  functionId: 'us-central1-onObjectDeleted',
  codebase: 'default',
  eventType: 'google.cloud.storage.object.v1.deleted',
  kind: 'storage',
}

/** A bulk delete's job, part way through, with what it skipped and what failed. */
const DELETE_JOB: Job = {
  id: 'ds-delete',
  kind: 'storage.delete',
  section: 'storage',
  title: 'Delete every object',
  total: 1_204,
  done: 412,
  skipped: 2,
  errors: [{ key: 'avatars/u_9f3k2.png', message: 'The rules refused this delete.', detail: null }],
  errorCount: 3,
  state: 'running',
  startedAt: new Date(NOW - 4_000).toISOString(),
  finishedAt: null,
}

/** The real confirmation (DangerConfirmBody), at rest in the card instead of over the page. */
function DangerConfirmCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="What goes, what fires, the way back"
          note="The trigger line is computed: each function that will run and how often, or that none listens."
        >
          <div className="flex flex-wrap items-start gap-6">
            <DangerConfirmBody
              title="Delete 3 users"
              description={
                <>
                  <span className="font-mono text-[0.9em] text-kumo-default">
                    u_9f3k2, u_2fc4c, u_2s5rh
                  </span>{' '}
                  are removed from the emulator.
                </>
              }
              line={{ kind: 'functions', functions: [DELETED_TRIGGER], times: 3 }}
              consequences={['Re-seed or re-import to get them back.']}
              testId="ds-danger-users"
            />
            <DangerConfirmBody
              title="Purge orders-queue"
              description="12 tasks waiting in orders-queue are removed."
              line={{ kind: 'none' }}
              consequences={['Tasks enqueued from now on are kept.']}
              progressVerb="purged"
              testId="ds-danger-purge"
            />
          </div>
        </Section>
        <Section
          title="Typed, then running as a job"
          note="Type-to-confirm for the big ones; progress, skipped and failed items from the job, and Cancel stops it."
        >
          <DangerConfirmBody
            title="Delete every object"
            description="1,204 objects are removed from demo.appspot.com."
            line={{ kind: 'functions', functions: [OBJECT_TRIGGER], times: 1_204 }}
            consequences={['Re-seed or re-import to get them back.']}
            confirmText="demo.appspot.com"
            typed="demo.appspot.com"
            job={DELETE_JOB}
            testId="ds-danger-job"
          />
        </Section>
        <Section
          title="When nothing is known, nothing is claimed"
          note="While Functions start there is no trigger line; while background triggers are paused it says so."
        >
          <div className="flex flex-wrap items-start gap-6">
            <DangerConfirmBody
              title="Delete 1 document"
              description="users/u_9f3k2 is removed from the emulator."
              consequences={['Re-seed or re-import to get it back.']}
              testId="ds-danger-unknown"
            />
            <DangerConfirmBody
              title="Delete 40 documents"
              description="Every document in events is removed from the emulator."
              line={{ kind: 'paused' }}
              consequences={['Re-seed or re-import to get them back.']}
              testId="ds-danger-paused"
            />
          </div>
        </Section>
      </Stack>
    </Kit>
  )
}

defineCards([
  {
    id: 'section-anatomy',
    group: 'Patterns',
    name: 'Section page anatomy',
    subtitle:
      'Panel with scope and tree, the two toolbar rows, table, inspector and footer — where each control lives',
    width: 1280,
    surface: 'canvas',
    render: () => <SectionAnatomy />,
  },
  {
    id: 'data-table-states',
    group: 'Patterns',
    name: 'Table states',
    subtitle:
      'Loading after 150 ms, none yet, no match, error with a fix, selection bar over row two, window footer, the "N new" pill, live flashes',
    width: 1100,
    surface: 'canvas',
    render: () => <TableStates />,
  },
  {
    id: 'data-table-states-dark',
    group: 'Patterns',
    name: 'Table states, dark',
    subtitle: 'The same, in dark mode',
    width: 1100,
    dark: true,
    surface: 'canvas',
    render: () => <TableStates />,
  },
  {
    id: 'inspector-anatomy',
    group: 'Patterns',
    name: 'Inspector',
    subtitle:
      'Title (an entity key in the data face), meta, actions, previous/next, tabs with counts, facts, sections that are one line when empty, the footer rule at 716 and 350 px',
    width: 880,
    surface: 'canvas',
    render: () => <InspectorAnatomy />,
  },
  {
    id: 'json-tree',
    group: 'Patterns',
    name: 'JSON tree and payloads',
    subtitle:
      'Collapsible tree with search, copy path and value, cut strings, paged containers, masked secrets, references as links; text and binary payloads',
    width: 880,
    surface: 'canvas',
    render: () => <JsonCard />,
  },
  {
    id: 'filter-field',
    group: 'Patterns',
    name: 'Filter field',
    subtitle:
      'Tokens on a tinted ground, key and value completion, an invalid filter and its message',
    width: 1100,
    surface: 'canvas',
    render: () => <FilterCard />,
  },
  {
    id: 'feed-list',
    group: 'Patterns',
    name: 'Feeds',
    subtitle: 'Following at the live edge, paused with "N new", the dropped-items note',
    width: 1100,
    surface: 'canvas',
    render: () => <FeedCard />,
  },
  {
    id: 'key-value-editor',
    group: 'Patterns',
    name: 'Key-value editor',
    subtitle: 'Rows with enable toggles and a duplicate warning; bulk edit',
    width: 720,
    surface: 'canvas',
    render: () => <KeyValueCard />,
  },
  {
    id: 'section-gate',
    group: 'Patterns',
    name: 'Section states',
    subtitle:
      'Not configured (the firebase.json lines and firenook init --adopt), left out by --only (the developer’s command with the name added), starting with what it waits for',
    width: 1100,
    surface: 'canvas',
    render: () => <GateCard />,
  },
  {
    id: 'nav-states',
    group: 'Patterns',
    name: 'Navigation states and badges',
    subtitle: 'Counter, gauge, danger; dimmed absent; pulsing starting; the collapsed nav’s dots',
    width: 880,
    surface: 'canvas',
    render: () => <NavCard />,
  },
  {
    id: 'live-channel-states',
    group: 'Patterns',
    name: 'Live channel states',
    subtitle:
      'The live badge’s states (reconnecting, engine stopped, too many tabs, unreachable, updated), LiveNotice for an ended subscription, the restart toast',
    width: 880,
    surface: 'canvas',
    render: () => <LiveChannelCard />,
  },
  {
    id: 'shell-banners',
    group: 'Patterns',
    name: 'Shell banners',
    subtitle:
      'Background triggers paused with Resume; the app uses another project, with Show and How to fix',
    width: 1100,
    surface: 'canvas',
    render: () => <BannersCard />,
  },
  {
    id: 'row-menu',
    group: 'Patterns',
    name: 'Row menu',
    subtitle: 'The same actions on right-click, Shift+F10 and the row’s ⋯; destructive last',
    width: 640,
    surface: 'canvas',
    render: () => <RowMenuCard />,
  },
  {
    id: 'facet-list',
    group: 'Patterns',
    name: 'Facets',
    subtitle: 'Level and service toggles with figures, pressed and not',
    width: 640,
    surface: 'canvas',
    render: () => <FacetCard />,
  },
  {
    id: 'code-block',
    group: 'Patterns',
    name: 'Code blocks',
    subtitle: 'firebase.json snippet, a command, the connect snippet with JS / Python / Go tabs',
    width: 880,
    surface: 'canvas',
    render: () => <CodeCard />,
  },
  {
    id: 'feed-gaps',
    group: 'Patterns',
    name: 'Feed gaps and pauses',
    subtitle:
      'A gap row after a reset, the paused pill and PauseButton ("Paused · 12 new"), a marker row, an expanded row with a stack trace',
    width: 1100,
    surface: 'canvas',
    render: () => <FeedGapsCard />,
  },
  {
    id: 'danger-confirm',
    group: 'Patterns',
    name: 'Destructive confirmation',
    subtitle: 'What goes, what fires, the way back; type to confirm; progress',
    width: 1100,
    surface: 'canvas',
    render: () => <DangerConfirmCard />,
  },
  {
    id: 'requires-notice',
    group: 'Patterns',
    name: 'Needs another section',
    subtitle: 'RequiresNotice for an absent and a starting section, with the fix',
    width: 720,
    surface: 'canvas',
    render: () => <RequiresCard />,
  },
  {
    id: 'masked-value',
    group: 'Patterns',
    name: 'Masked values',
    subtitle: 'A hash, a secret revealed on demand (pending, revealed, failed)',
    width: 640,
    surface: 'canvas',
    render: () => <MaskedCard />,
  },
])
