import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  InlineCopyText,
  LayerCard,
  Link,
  Select,
  Sidebar,
  Switch,
  Table,
  Tabs,
  Text,
  TooltipProvider,
} from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  BracketsCurlyIcon,
  CaretDownIcon,
  CaretRightIcon,
  CommandIcon,
  CopyIcon,
  DatabaseIcon,
  DownloadSimpleIcon,
  FolderIcon,
  EnvelopeSimpleIcon,
  FunnelSimpleIcon,
  CheckCircleIcon,
  GaugeIcon,
  GoogleLogoIcon,
  KeyIcon,
  LightningIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  PasswordIcon,
  PhoneIcon,
  PlusIcon,
  ShieldCheckIcon,
  SquareHalfIcon,
  TrashIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { CSSProperties, ReactNode } from 'react'
import { AREA_LABELS, SECTIONS, type ServiceArea } from '@/lib/services'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

const AREAS: readonly ServiceArea[] = ['data', 'compute', 'messaging', 'observe']

function LiveDot({ changes }: { changes?: number }) {
  return (
    <span className="flex items-center gap-1.5 text-sm text-kumo-subtle">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full rounded-full bg-kumo-success opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-kumo-success" />
      </span>
      live{changes ? ` · ${changes} changes` : ''}
    </span>
  )
}

const SHELL_SHAPE = [
  { id: 'events', depth: 0, count: '40' },
  { id: 'products', depth: 0, count: '60', below: 1 },
  { id: 'teams', depth: 0, count: '1', below: 1 },
  { id: 'users', depth: 0, count: '211,260', open: true },
  { id: 'orders', depth: 1, count: '12,340', current: true, open: true },
  { id: 'items', depth: 2, count: '30,100' },
  { id: 'sessions', depth: 1, count: '6,020' },
] as const

function SchemaTreeRows({ rows }: { rows: typeof SHELL_SHAPE }) {
  return (
    <ul className="grid gap-px p-1.5">
      {rows.map((node) => (
        <li key={`${node.depth}-${node.id}`}>
          <div
            className={`flex h-7 items-center rounded-md pr-1.5 ${
              'current' in node && node.current
                ? 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-kumo-brand)]'
                : ''
            }`}
          >
            {Array.from({ length: node.depth }, (_, level) => (
              <span key={level} className="relative h-full w-[14px] shrink-0">
                <span className="absolute top-0 bottom-0 left-[9px] border-l border-kumo-hairline" />
              </span>
            ))}
            <span className="flex size-5 shrink-0 items-center justify-center text-kumo-subtle">
              {'open' in node && node.open ? (
                <CaretRightIcon size={11} weight="bold" className="rotate-90" />
              ) : 'below' in node ? (
                <CaretRightIcon size={11} weight="bold" />
              ) : null}
            </span>
            {node.depth === 0 ? (
              <DatabaseIcon size={13} className="shrink-0 text-kumo-subtle" />
            ) : (
              <FolderIcon size={13} className="shrink-0 text-kumo-subtle" />
            )}
            <span className="ml-1.5 min-w-0 flex-1 truncate font-mono text-[12px] text-kumo-default">
              {node.id}
            </span>
            {'below' in node && (
              <span className="mr-1.5 font-mono text-[10px] text-kumo-inactive tabular-nums">
                +{node.below}
              </span>
            )}
            <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
              {node.count}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function PanelHead() {
  return (
    <div className="grid shrink-0 gap-1.5 border-b border-kumo-line p-2">
      <Select
        size="sm"
        value="(default)"
        items={{ '(default)': '(default)' }}
        className="w-full font-mono"
        aria-label="Database"
      />
      <div className="flex h-7 items-center gap-1.5 rounded-md bg-kumo-control px-2 text-xs text-kumo-inactive ring ring-kumo-line">
        <MagnifyingGlassIcon size={14} />
        Filter collections
      </div>
    </div>
  )
}

function Shell() {
  return (
    <TooltipProvider>
      <div className="grid gap-4">
        <div className="flex h-[640px] w-full overflow-hidden rounded-lg ring ring-kumo-hairline">
          <Sidebar.Provider
            contained
            defaultOpen
            className="h-full w-auto shrink-0 min-h-0!"
            style={{ '--sidebar-width': '14rem' } as CSSProperties}
          >
            <Sidebar>
              <Sidebar.Header>
                <div className="flex items-center gap-2 px-2 py-1">
                  <span className="flex size-6 items-center justify-center rounded-md bg-kumo-brand text-white">
                    <GaugeIcon size={14} weight="bold" />
                  </span>
                  <Text bold>Firenook</Text>
                  <Text variant="secondary">console</Text>
                </div>
              </Sidebar.Header>
              <Sidebar.Content>
                <Sidebar.Group>
                  <Sidebar.Menu>
                    <Sidebar.MenuButton icon={GaugeIcon}>Overview</Sidebar.MenuButton>
                  </Sidebar.Menu>
                </Sidebar.Group>
                {AREAS.map((area) => (
                  <Sidebar.Group key={area}>
                    <Sidebar.GroupLabel>{AREA_LABELS[area]}</Sidebar.GroupLabel>
                    <Sidebar.Menu>
                      {SECTIONS.filter((section) => section.area === area).map((section) => (
                        <Sidebar.MenuButton
                          key={section.to}
                          icon={section.icon}
                          active={section.to === '/firestore'}
                        >
                          {section.label}
                        </Sidebar.MenuButton>
                      ))}
                    </Sidebar.Menu>
                  </Sidebar.Group>
                ))}
              </Sidebar.Content>
              <Sidebar.Footer>
                <Sidebar.Trigger />
              </Sidebar.Footer>
            </Sidebar>
          </Sidebar.Provider>
          <div className="flex min-w-0 flex-1 flex-col bg-kumo-canvas">
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-kumo-line bg-kumo-base pr-4 pl-2">
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<SquareHalfIcon />}
                aria-label="Hide the schema panel"
                className="text-kumo-default"
              />
              <div className="flex min-w-0 items-center gap-2">
                <Text variant="secondary" size="sm">
                  Project
                </Text>
                <InlineCopyText value="demo-shop-local" className="font-mono text-[0.9em]">
                  demo-shop-local
                </InlineCopyText>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Badge variant="success" appearance="dot">
                  engine 0.2.0
                </Badge>
                <Button variant="ghost" size="sm" icon={<CommandIcon />}>
                  <span className="flex items-center gap-1.5">
                    Search
                    <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px]">
                      ⌘K
                    </kbd>
                  </span>
                </Button>
              </div>
            </header>
            <div className="flex min-h-0 flex-1">
              <aside className="flex w-[264px] shrink-0 flex-col border-r border-kumo-line bg-kumo-base">
                <PanelHead />
                <div className="min-h-0 flex-1 overflow-hidden">
                  <SchemaTreeRows rows={SHELL_SHAPE} />
                </div>
                <div className="grid shrink-0 gap-0.5 border-t border-kumo-line px-3 py-1.5">
                  <span className="font-mono text-[11px] text-kumo-subtle">users/*/orders</span>
                  <span className="text-[12px] text-kumo-default tabular-nums">
                    12,340 documents{' '}
                    <span className="text-kumo-subtle">
                      in 4,100 of 211,260 <span className="font-mono text-[11px]">users</span>
                    </span>
                  </span>
                </div>
              </aside>
              <main className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-11 shrink-0 items-center gap-1 border-b border-kumo-line bg-kumo-base pr-2 pl-3">
                  <PathSegment label="(default)" />
                  <span className="px-0.5 text-kumo-inactive">/</span>
                  <PathSegment label="users" count="211,260" />
                  <span className="px-0.5 text-kumo-inactive">/</span>
                  <span className="px-1.5 font-mono text-[13px] text-kumo-inactive">*</span>
                  <span className="px-0.5 text-kumo-inactive">/</span>
                  <PathSegment label="orders" count="12,340" current />
                  <span className="ml-auto flex items-center gap-1">
                    <Button variant="primary" size="sm">
                      group
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      icon={<CopyIcon />}
                      aria-label="Copy the path"
                    />
                    <span className="mx-1.5 h-5 w-px bg-kumo-line" />
                    <LiveDot />
                    <Button variant="primary" size="sm" icon={<PlusIcon />} className="ml-1">
                      New
                    </Button>
                  </span>
                </div>
                <div className="flex flex-1 items-center justify-center bg-kumo-base">
                  <Text variant="secondary">
                    The grid, edge to edge; the inspector opens beside it.
                  </Text>
                </div>
              </main>
            </div>
          </div>
        </div>
        <Text variant="secondary" size="sm">
          The navigation is Kumo's sidebar, expanded or collapsed to icons; collapsed, the labels
          slide out over the page while the pointer is on it and go back when it leaves. The control
          at its foot and{' '}
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px]">[</kbd>{' '}
          flip it, and the choice is kept per browser. The panel beside the content is the section's
          own column: Firestore fills it with the database, a filter and the schema tree; the button
          above it and{' '}
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px]">t</kbd>{' '}
          hide and show it. Sections without a panel take the full width.
        </Text>
      </div>
    </TooltipProvider>
  )
}

function PathSegment({
  label,
  count,
  current,
}: {
  label: string
  count?: string
  current?: boolean
}) {
  return (
    <span className="flex items-center gap-1">
      {current ? (
        <span className="rounded-md bg-kumo-tint px-1.5 py-0.5 font-mono text-[13px] text-kumo-strong">
          {label}
        </span>
      ) : (
        <Link
          href="#"
          variant="plain"
          className="rounded-md px-1.5 py-0.5 font-mono text-[13px] hover:bg-kumo-tint"
        >
          {label}
        </Link>
      )}
      {count ? <span className="font-mono text-[11px] text-kumo-subtle">{count}</span> : null}
    </span>
  )
}

function Chip({ children, onRemove }: { children: string; onRemove?: boolean }) {
  return (
    <span className="inline-flex h-6.5 items-center gap-1 rounded-md bg-kumo-base px-2 font-mono text-[12px] text-kumo-default ring ring-kumo-line">
      {children}
      {onRemove ? <XIcon size={12} className="text-kumo-subtle" /> : null}
    </span>
  )
}

function PathAndQuery() {
  return (
    <Stack>
      <Section
        title="Path bar"
        note="Type or paste a path to go there. Each segment links, each collection shows its count from the index, and the current segment is filled."
      >
        <div className="flex h-11 items-center gap-2 rounded-lg bg-kumo-base px-3 ring ring-kumo-line">
          <DatabaseIcon size={16} className="text-kumo-subtle" />
          <PathSegment label="(default)" />
          <CaretRightIcon size={12} className="text-kumo-inactive" />
          <PathSegment label="users" count="211,260" />
          <CaretRightIcon size={12} className="text-kumo-inactive" />
          <PathSegment label="u_9f3k2" />
          <CaretRightIcon size={12} className="text-kumo-inactive" />
          <PathSegment label="orders" count="33" current />
          <span className="ml-auto flex items-center gap-2">
            <Badge variant="outline">group: orders</Badge>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CopyIcon />}
              aria-label="Copy path"
            />
          </span>
        </div>
      </Section>
      <Section
        title="Query bar"
        note="Form mode reads like the SDK chain. It runs the same engine query the app runs, with a live count from the index and an explain toggle that says whether production would need a composite index."
      >
        <div className="grid gap-2 rounded-lg bg-kumo-base p-3 ring ring-kumo-line">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              variant="segmented"
              size="sm"
              tabs={[
                { value: 'form', label: 'Form' },
                { value: 'text', label: 'Text' },
              ]}
              selectedValue="form"
            />
            <Chip onRemove>where status == "paid"</Chip>
            <Chip onRemove>orderBy createdAt desc</Chip>
            <Chip>limit 50</Chip>
            <Button variant="ghost" size="sm" icon={<PlusIcon />}>
              Add clause
            </Button>
            <span className="ml-auto flex items-center gap-3">
              <span className="text-sm text-kumo-subtle">
                <span className="font-mono text-[0.9em] text-kumo-default">12,345</span> match ·
                count 4 ms
              </span>
              <Button variant="ghost" size="sm" icon={<LightningIcon />}>
                Explain
              </Button>
              <Button variant="primary" size="sm">
                Run
              </Button>
            </span>
          </div>
          <div className="flex items-center gap-3 border-t border-kumo-hairline pt-2">
            <Text variant="secondary" size="sm">
              View as
            </Text>
            <Select
              size="sm"
              defaultValue="u_9f3k2"
              items={{
                anonymous: 'Anonymous',
                u_9f3k2: 'ada@example.test',
                admin: 'Admin SDK (bypasses rules)',
              }}
              className="w-64"
            />
            <Badge variant="warning" appearance="dot">
              2 of 50 rows denied for this user
            </Badge>
            <span className="ml-auto">
              <LiveDot changes={3} />
            </span>
          </div>
        </div>
      </Section>
    </Stack>
  )
}

/**
 * One quiet chip for every type: the word already names it, and a colour
 * per type spends the whole palette on something nobody has to look up.
 * `mixed` is the exception, because a column disagreeing with itself is
 * worth a glance — and it is the only amber in the grid, so it gets one.
 */
function TypeChip({
  type,
  mixed,
  menu,
}: {
  type: string
  mixed?: string | undefined
  menu?: boolean | undefined
}) {
  return (
    <span
      className={`flex h-4.5 shrink-0 items-center gap-1 rounded px-1 font-mono text-[11px] ${
        mixed ? 'bg-kumo-warning-tint text-kumo-default' : 'bg-kumo-tint text-kumo-subtle'
      }`}
      title={mixed ? `More than one type here: ${mixed}` : undefined}
    >
      {mixed && <span className="size-1.5 shrink-0 rounded-full bg-kumo-warning" />}
      {type}
      {/* The same chip labels a column and opens the type menu on a field
          row. The one that can be changed says so with a caret, not with a
          colour: colour here is spent on `mixed` and nothing else. */}
      {menu && <CaretDownIcon size={9} className="-mr-0.5 shrink-0 opacity-70" />}
    </span>
  )
}

function TypeHead({ label, type, mixed }: { label: string; type: string; mixed?: string }) {
  return (
    <Table.Head>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[12px] font-medium">{label}</span>
        <TypeChip type={type} mixed={mixed} />
      </span>
    </Table.Head>
  )
}

const GRID = [
  {
    id: 'o_20251',
    status: 'paid',
    total: '42.00',
    created: '2 min ago',
    exact: '10:14:02',
    customer: 'users/u_9f3k2',
    items: 3,
    state: 'flash',
  },
  {
    id: 'o_20250',
    status: 'paid',
    total: '18.50',
    created: '1 h ago',
    exact: '09:02:11',
    customer: 'users/u_9f3k2',
    items: 1,
    state: 'selected',
  },
  {
    id: 'o_20249',
    status: 'refunded',
    total: '99.00',
    created: 'yesterday',
    exact: '17:44:09',
    customer: 'users/u_1x8pq',
    items: 2,
    state: 'denied',
  },
  {
    id: 'o_20248',
    status: 'pending',
    total: '7.25',
    created: '3 days ago',
    exact: '08:10:31',
    customer: 'users/u_7c0aa',
    items: 4,
    state: '',
  },
  {
    id: 'o_20247',
    status: '',
    total: '',
    created: '',
    exact: '',
    customer: '',
    items: 0,
    state: 'missing',
  },
]

function DataGrid() {
  return (
    <Stack>
      <Section
        title="Data grid"
        note="Columns are inferred from the loaded page and tagged with their value type. Ids copy on hover, references jump, timestamps show relative time with the exact time beside it. A row the viewed-as user cannot read is muted with a lock; a missing ancestor is muted in italics; a row that just changed flashes on the tint."
      >
        <LayerCard className="p-0">
          <Table>
            <Table.Header variant="compact">
              <Table.Row>
                <Table.CheckHead
                  checked={false}
                  indeterminate
                  onCheckedChange={() => {}}
                  aria-label="Select all"
                />
                <TypeHead label="id" type="doc" />
                <TypeHead label="status" type="string" />
                <TypeHead label="total" type="number" />
                <TypeHead label="createdAt" type="timestamp" mixed="timestamp ×3, null ×1" />
                <TypeHead label="customer" type="reference" />
                <TypeHead label="items" type="array" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {GRID.map((row) => {
                const muted = row.state === 'denied' || row.state === 'missing'
                return (
                  <Table.Row
                    key={row.id}
                    className={`group ${row.state === 'flash' ? 'bg-kumo-success-tint' : ''} ${muted ? 'text-kumo-subtle' : ''}`}
                    variant={row.state === 'selected' ? 'selected' : 'default'}
                  >
                    <Table.CheckCell
                      checked={row.state === 'selected'}
                      onCheckedChange={() => {}}
                      aria-label={`Select ${row.id}`}
                    />
                    <Table.Cell>
                      <span className="flex items-center gap-2">
                        {row.state === 'denied' ? (
                          <LockSimpleIcon size={14} className="text-kumo-warning" />
                        ) : null}
                        <InlineCopyText
                          value={row.id}
                          className={`font-mono text-[0.9em] ${row.state === 'missing' ? 'italic' : ''}`}
                        >
                          {row.id}
                        </InlineCopyText>
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      {row.state === 'missing' ? (
                        <span className="text-[13px] italic">
                          missing document · 2 subcollections
                        </span>
                      ) : row.state === 'denied' ? (
                        <span className="text-[13px]">denied by rules line 14</span>
                      ) : (
                        <Badge
                          variant={
                            row.status === 'paid'
                              ? 'success'
                              : row.status === 'refunded'
                                ? 'neutral'
                                : 'warning'
                          }
                          appearance="dot"
                        >
                          {row.status}
                        </Badge>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-mono text-[0.9em] tabular-nums">{row.total}</span>
                    </Table.Cell>
                    <Table.Cell>
                      {row.created ? (
                        <span className="flex items-baseline gap-2">
                          <span className="text-[13px]">{row.created}</span>
                          <span className="font-mono text-[11px] text-kumo-subtle">
                            {row.exact}
                          </span>
                        </span>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell>
                      {row.customer ? (
                        <Link href="#" className="font-mono text-[0.9em]">
                          {row.customer}
                        </Link>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell>
                      {row.items ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-kumo-tint px-1.5 py-0.5 font-mono text-[11px]">
                          <BracketsCurlyIcon size={12} />[{row.items}]
                        </span>
                      ) : null}
                    </Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table>
          <div className="flex items-center gap-3 border-t border-kumo-hairline px-3 py-2">
            <Text variant="secondary" size="sm">
              Rows 1–50 of 12,345 · virtualized
            </Text>
            <span className="ml-auto flex items-center gap-2">
              <Button variant="secondary" size="sm" icon={<TrashIcon />}>
                Delete 1
              </Button>
              <Button variant="secondary" size="sm" icon={<CopyIcon />}>
                Copy as JSON
              </Button>
            </span>
          </div>
        </LayerCard>
      </Section>
    </Stack>
  )
}

/**
 * One row of the field tree, and it recurses.
 *
 * A field of a document, an entry of a map and an element of an array are
 * the same object — a name (or an index), a type, a value — so they are one
 * row. That is what lets the panel edit a nested structure at all: the case
 * a form beats raw JSON at is nesting, and a panel that drops to a textarea
 * the moment a value stops being flat has given up exactly where it was
 * wanted.
 *
 * A row is one line, and a name and its value share it. A document is a
 * tree, and a tree is legible only when a node is a line: on two lines
 * every node is a block, and an indent of sixteen pixels says nothing
 * against a block forty-seven pixels tall. Every row carries the caret
 * column whether or not it has a caret, so depth is the only thing that
 * moves a name — giving it to maps alone indented them past their own
 * siblings, and past their own children.
 *
 * The name wears no chrome until the line is pointed at, because it is read
 * far more often than it is changed, and editing it is the rename Firestore
 * has no operation for: a delete and a set, in this document only.
 */
/**
 * A list of siblings and the two columns they share: one sized to the
 * widest name among them, one taking the rest. Names were a column already
 * and values were not — on a real document they began at eight different
 * offsets spread over 58 px, so reading down the values meant following a
 * staircase. `max-content` finds the width with no measuring, and each row
 * is a `subgrid` so it can still paint its own ground.
 *
 * The air between the rows is the other half of giving a value a box: a
 * column of boxes two pixels apart is a wall, and the same column twelve
 * pixels apart is a list. The air goes between two fields and not inside
 * one, though: a row holds its line, its notes and its children, and a
 * subgrid inherits the gaps above it unless it says otherwise.
 */
const BETWEEN = 'gap-y-3.5'

/** One control of a row's strip: the same square for every one of them. */
const STRIP_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
const WITHIN = 'gap-y-1'
const COLUMNS = `grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-2 ${BETWEEN}`

function FieldRow({
  name,
  index,
  type,
  note,
  removed,
  unsaved,
  pointed,
  value,
  children,
}: {
  name?: string | undefined
  index?: number | undefined
  type?: string | undefined
  note?: string | undefined
  removed?: boolean | undefined
  unsaved?: boolean | undefined
  /** Drawn as it is under the pointer: the ground and the controls arrive. */
  pointed?: boolean | undefined
  value?: ReactNode
  children?: ReactNode
}) {
  if (removed)
    return (
      <div className="col-span-2 flex items-center gap-1 rounded-md py-0.5 pr-1 pl-0.5 opacity-70">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] line-through">{name}</span>
        <span className="shrink-0 text-[11px] text-kumo-subtle">Removed on save</span>
        <Button variant="ghost" size="xs" icon={<ArrowCounterClockwiseIcon />}>
          Undo
        </Button>
      </div>
    )
  return (
    <div className={`col-span-2 grid grid-cols-subgrid ${WITHIN}`}>
      {/* The ground belongs to the line, not to each control. Hovering a
          row is how you see which field you are on — the question a column
          of twenty one-line rows has to answer and a column of blocks
          never had to. */}
      <div
        className={`relative col-span-2 grid grid-cols-subgrid items-start ${
          children ? 'rounded-r-md' : 'rounded-md'
        } ${pointed ? 'bg-kumo-tint' : ''}`}
      >
        <div className="flex items-start gap-1">
          {/* The caret hangs in the panel's margin rather than standing in
              a column of its own. A column costs every row to serve the
              few: one map in a document of fourteen fields meant 18 px of
              nothing thirteen times. Out of the flow it cannot push a
              name, so siblings stay aligned for free. */}
          {children ? (
            <span
              className={`absolute top-0 -left-4 flex h-8 w-4 items-center justify-center rounded-l-md text-kumo-subtle ${
                pointed ? 'bg-kumo-tint' : ''
              }`}
            >
              <CaretDownIcon size={12} />
            </span>
          ) : null}
          {index === undefined ? (
            <span className="flex h-8 shrink-0 items-center rounded px-1.5 text-[13px] font-medium">
              {name}
            </span>
          ) : (
            <span className="flex h-8 min-w-4 shrink-0 items-center justify-end font-mono text-[12px] text-kumo-subtle tabular-nums">
              {index}
            </span>
          )}
          {/* Which fields the footer's count is counting: Save is the row's
              own accent, and this is what it is about to write. Its place
              is always kept, or the name column would widen and shift
              every value the first time one was edited. */}
          <span className="flex h-8 w-1.5 shrink-0 items-center">
            {unsaved && <span className="size-1.5 rounded-full bg-kumo-brand" />}
          </span>
        </div>
        <div className="flex min-w-0 items-start gap-1 pr-1">{value}</div>
        {/* Every control that is not the value, in one strip drawn over the
            end of the line. It overlays rather than reserves: keeping its
            place cost ninety-three of a line's four hundred and five
            pixels, held open at rest for buttons not drawn at rest. It
            floats — its own ground, a hairline, a shadow — because a strip
            in the line's own tint cut a notch out of the box it covered.

            The strip owns its buttons. Kumo's square button renders 12 px
            at this root size and has no pressed state to offer, and three
            12 px squares two pixels apart read as one smudge: so one
            square, one gap, and `on` is something you can see. */}
        <span
          className={`absolute top-0.5 right-1 flex h-7 items-center gap-1 rounded-md bg-kumo-base px-1 shadow-sm ring ring-kumo-line ${
            pointed ? '' : 'opacity-0'
          }`}
        >
          {type && <TypeChip type={type} menu />}
          <span className={STRIP_BUTTON}>
            <BracketsCurlyIcon size={14} />
          </span>
          {/* The same control, while what it toggles is on. */}
          <span className={`${STRIP_BUTTON} bg-kumo-control text-kumo-default ring ring-kumo-line`}>
            <BracketsCurlyIcon size={14} />
          </span>
          <span className={`${STRIP_BUTTON} hover:text-kumo-danger`}>
            <TrashIcon size={14} />
          </span>
        </span>
      </div>
      {note && <span className="col-span-2 block text-[11px] text-kumo-subtle">{note}</span>}
      {children && <Nested>{children}</Nested>}
    </div>
  )
}

/**
 * The entries of a map or the items of an array, under a guide line that
 * descends from the caret which opened them. The step is the caret's own
 * width, so a child's name lands one column right of its parent's rather
 * than, as it did, to the left of it.
 */
function Nested({ children }: { children: ReactNode }) {
  // The guide line runs down the parent caret's middle, which is −7 px
  // from the name column and so −2 on a 14 px root. It used to sit at
  // +3.5, inside the column, while the caret hangs outside it: eleven
  // pixels of white between the chevron and the line it heads, the same
  // eleven at every depth. An arrow and a rail that never meet are two
  // marks near each other, not a statement about what contains what. The
  // padding carries what the margin gave up, so the indent is unchanged.
  //
  // `subgrid`, not a grid of its own: a nested list that sized a name
  // column to its own widest name started its values 26 px LEFT of its
  // parent's siblings and ran that much wider, so a child burst out of the
  // column containing it. A subgrid takes its own margin and padding out of
  // the edge track, so the indent narrows the names and every value in the
  // document stays on one rail.
  return (
    <div
      className={`col-span-2 -ml-2 grid grid-cols-subgrid border-l border-kumo-line pl-8 ${BETWEEN}`}
    >
      {children}
    </div>
  )
}

/**
 * A value that can be any length wraps rather than running off the end of
 * its line: a console is for reading a document before it is for editing
 * one, and a value cut short at the panel's edge is a value the panel
 * failed to show — a URL loses its path, which is the half that says
 * anything. An `input` cannot wrap at all, so these are `textarea`s that
 * hold one line most of the time.
 *
 * A value wears a box at rest. It did not, on the rule that it is text you
 * read far more often than you change, and the rule was wrong about what
 * the reader needs to know: a bordered control says "you can type here"
 * before anybody tries one, and a column of bare text says the opposite.
 * The box costs nothing — a ring is painted with a shadow, so a boxed line
 * is exactly as tall as a bare one — and what the old rule was protecting
 * against was boxes stacked two pixels apart, which is a question of air.
 *
 * The word a value is followed by — `double`, `ref`, `2 mo ago` — goes
 * inside the box at its end, and the label two of them read on from —
 * `lat`, `lng` — inside at its start. Outside, the control had to be
 * content-wide to keep the two together, which meant a column of boxes in
 * eight different widths.
 */
function Value({
  children,
  lead,
  word,
  state = 'rest',
  className = '',
}: {
  children: ReactNode
  lead?: ReactNode
  word?: ReactNode
  state?: 'rest' | 'focus'
  className?: string
}) {
  const ring = state === 'focus' ? 'ring-kumo-focus' : 'ring-kumo-line'
  return (
    <div
      className={`flex min-w-0 flex-1 items-start rounded-md bg-kumo-control ring ${ring} ${className}`}
    >
      {lead !== undefined && (
        <span className="flex h-8 shrink-0 items-center pl-2 font-mono text-[11px] text-kumo-inactive">
          {lead}
        </span>
      )}
      <div className="min-w-0 flex-1 px-1.5 py-[5px] font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-kumo-default [overflow-wrap:break-word]">
        {children}
      </div>
      {word !== undefined && (
        <span className="flex h-8 shrink-0 items-center pr-1.5 pl-1 font-mono text-[11px] text-kumo-subtle">
          {word}
        </span>
      )}
    </div>
  )
}

/**
 * What a shut map or array says on its own line. Open, it says nothing:
 * its fields are listed directly beneath it, which is the one thing the
 * count it used to show — `{ 1 field }` — was telling anybody. It is also
 * the way in: the caret is four pixels of chevron and these are the words
 * the eye went to, so they open it too.
 */
function Summary({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      className="flex h-8 min-w-0 flex-1 cursor-pointer items-center truncate rounded text-left font-mono text-[12px] text-kumo-subtle hover:text-kumo-default"
    >
      {children}
    </button>
  )
}

function Inspector() {
  return (
    <Stack>
      <Section
        title="Inspector"
        note="The selected document as one recursive row: a name, a type, a value, in two columns a list of siblings shares — the panel itself drags wider when a document wants more room, and opens at a share of the window rather than a number picked on a laptop. Every value wears a box, because a value you can type into should say so before anybody tries one. Maps and arrays open in place rather than falling back to a JSON textarea, every type gets the editor it needs, and what is typed is checked as it is typed. Fields or JSON. Subcollections beneath with counts. Copy as code emits the read or write in the SDK dialect the developer chooses."
      >
        <LayerCard className="w-[520px] p-0">
          <LayerCard.Secondary className="flex items-center gap-2">
            <InlineCopyText value="users/u_9f3k2/orders/o_20251" className="font-mono text-[0.9em]">
              users/u_9f3k2/orders/o_20251
            </InlineCopyText>
            <span className="ml-auto flex items-center gap-1">
              <Badge variant="neutral">rev 4,812</Badge>
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<ArrowSquareOutIcon />}
                aria-label="Open in a new tab"
              />
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<XIcon />}
                aria-label="Close"
              />
            </span>
          </LayerCard.Secondary>
          <LayerCard.Primary className="grid gap-4">
            <Tabs
              variant="segmented"
              size="sm"
              tabs={[
                { value: 'fields', label: 'Fields' },
                { value: 'json', label: 'JSON' },
              ]}
              selectedValue="fields"
            />
            <div className={COLUMNS}>
              <FieldRow name="status" type="string" value={<Value>paid</Value>} />
              {/* Two lines because it needs two, and the name stays on the
                  first of them rather than floating between both. */}
              <FieldRow
                name="redirectUri"
                type="string"
                value={<Value>example-dev://app/gateway/callback?state=U3kVZ4r1ADid</Value>}
              />
              <FieldRow
                name="total"
                type="number"
                value={
                  /* `3` is how Firestore writes an integer and a double
                     alike, so nothing in the text can say which this is.
                     The editor says it, and lets it be changed — inside the
                     box at its end, so the word stays beside its value and
                     the column stays a column. */
                  <Value word="double">42</Value>
                }
              />
              <FieldRow
                name="paid"
                type="boolean"
                value={
                  <div className="flex h-8 items-center">
                    <Switch variant="neutral" size="sm" checked onCheckedChange={() => {}} />
                    <span className="ml-2 font-mono text-[12px] text-kumo-subtle">true</span>
                  </div>
                }
              />
              <FieldRow
                name="createdAt"
                type="timestamp"
                value={<Value word="2 mo ago">2026-09-20T10:14:02.117Z</Value>}
              />
              {/* Pointed at: the ground arrives on the line, and so does
                  every control that is not the value. */}
              <FieldRow
                name="buyer"
                type="reference"
                note="Renaming customer here changes this document only."
                unsaved
                pointed
                value={<Value word="ref">users/u_9f3k2</Value>}
              />
              <FieldRow
                name="office"
                type="geopoint"
                value={
                  <>
                    <Value lead="lat">3.139</Value>
                    <Value lead="lng">101.6869</Value>
                  </>
                }
              />
              {/* Open: the children say what is in it. The value column
                  runs on through every depth, so a child is never wider
                  than the row containing it. */}
              <FieldRow name="billing" type="map">
                <FieldRow name="currency" type="string" value={<Value>MYR</Value>} />
                <FieldRow name="contacts" type="array">
                  <FieldRow index={0} type="map">
                    <FieldRow name="email" type="string" value={<Value>ada@example.test</Value>} />
                  </FieldRow>
                </FieldRow>
              </FieldRow>
              {/* Shut, and large enough to have opened that way: the keys,
                  and how many more there are. */}
              <FieldRow
                name="permissions"
                type="map"
                value={<Summary>{'{ admin, billing, exports, +5 }'}</Summary>}
              />
              <FieldRow name="legacy" type="string" removed />
            </div>
            {/* Below the rows, not among them: a document with forty fields
                should not need scrolling to the end to gain a forty-first,
                and the name completes from what the rest of the collection
                calls its fields, bringing that field's usual type with it. */}
            {/* The name being typed belongs in the column the names above
                it are in, which is the drawer's own column now. */}
            <div className="flex items-center gap-1 border-t border-kumo-line pt-3">
              <Value className="text-kumo-inactive">New field name</Value>
              <TypeChip type="string" menu />
              <Button variant="ghost" size="sm" icon={<PlusIcon />}>
                Add field
              </Button>
            </div>
            <Collapsible.Root defaultOpen>
              <Collapsible.DefaultTrigger>Subcollections (2)</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <div className="grid gap-1">
                  <Link href="#" className="font-mono text-[0.9em]">
                    events · 12
                  </Link>
                  <Link href="#" className="font-mono text-[0.9em]">
                    notes · 1
                  </Link>
                </div>
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
            <div className="flex items-center gap-2 border-t border-kumo-hairline pt-4">
              <Button variant="primary" size="sm">
                Save
              </Button>
              <Button variant="secondary" size="sm" icon={<CopyIcon />}>
                Copy as code
              </Button>
              <span className="ml-auto">
                <Button variant="secondary-destructive" size="sm" icon={<TrashIcon />}>
                  Delete
                </Button>
              </span>
            </div>
          </LayerCard.Primary>
        </LayerCard>
      </Section>
    </Stack>
  )
}

function Avatar({ initials }: { initials: string }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-kumo-tint text-[11px] font-medium text-kumo-strong ring ring-kumo-hairline">
      {initials}
    </span>
  )
}

function Providers({ list }: { list: readonly ('password' | 'phone' | 'google')[] }) {
  return (
    <span className="flex items-center gap-1 text-kumo-subtle">
      {list.includes('password') ? <PasswordIcon size={16} /> : null}
      {list.includes('phone') ? <PhoneIcon size={16} /> : null}
      {list.includes('google') ? <GoogleLogoIcon size={16} /> : null}
    </span>
  )
}

function AuthPatterns() {
  return (
    <Stack>
      <Section
        title="User rows"
        note="Identity, providers, tenant, trust badges and last sign-in in one row. Actions live in the row menu: mint a token, sign in as, view Firestore as, disable, delete."
      >
        <LayerCard className="p-0">
          <Table>
            <Table.Header variant="compact">
              <Table.Row>
                <Table.Head>identity</Table.Head>
                <Table.Head>providers</Table.Head>
                <Table.Head>tenant</Table.Head>
                <Table.Head>trust</Table.Head>
                <Table.Head>last sign-in</Table.Head>
                <Table.Head>claims</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              <Table.Row className="group">
                <Table.Cell>
                  <span className="flex items-center gap-2">
                    <Avatar initials="AL" />
                    <span className="grid">
                      <span className="text-[13px]">ada@example.test</span>
                      <InlineCopyText
                        value="u_9f3k2"
                        className="font-mono text-[11px] text-kumo-subtle"
                      >
                        u_9f3k2
                      </InlineCopyText>
                    </span>
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <Providers list={['password', 'google']} />
                </Table.Cell>
                <Table.Cell>
                  <Badge variant="outline">default</Badge>
                </Table.Cell>
                <Table.Cell>
                  <span className="flex items-center gap-1">
                    <Badge variant="success" icon={<ShieldCheckIcon />}>
                      verified
                    </Badge>
                    <Badge variant="info" icon={<KeyIcon />}>
                      MFA
                    </Badge>
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <span className="text-[13px]">2 min ago</span>
                </Table.Cell>
                <Table.Cell>
                  <span className="font-mono text-[11px] text-kumo-subtle">
                    {'{ role: "admin" }'}
                  </span>
                </Table.Cell>
              </Table.Row>
              <Table.Row className="group">
                <Table.Cell>
                  <span className="flex items-center gap-2">
                    <Avatar initials="+1" />
                    <span className="grid">
                      <span className="text-[13px]">+1 555 0100</span>
                      <InlineCopyText
                        value="u_1x8pq"
                        className="font-mono text-[11px] text-kumo-subtle"
                      >
                        u_1x8pq
                      </InlineCopyText>
                    </span>
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <Providers list={['phone']} />
                </Table.Cell>
                <Table.Cell>
                  <Badge variant="outline">shop-eu</Badge>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant="warning" appearance="dot">
                    unverified
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  <span className="text-[13px]">yesterday</span>
                </Table.Cell>
                <Table.Cell>
                  <span className="font-mono text-[11px] text-kumo-subtle">—</span>
                </Table.Cell>
              </Table.Row>
              <Table.Row className="group text-kumo-subtle">
                <Table.Cell>
                  <span className="flex items-center gap-2">
                    <Avatar initials="RK" />
                    <span className="grid">
                      <span className="text-[13px] line-through">rk@example.test</span>
                      <InlineCopyText
                        value="u_7c0aa"
                        className="font-mono text-[11px] text-kumo-subtle"
                      >
                        u_7c0aa
                      </InlineCopyText>
                    </span>
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <Providers list={['password']} />
                </Table.Cell>
                <Table.Cell>
                  <Badge variant="outline">default</Badge>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant="error" appearance="dot">
                    disabled
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  <span className="text-[13px]">12 days ago</span>
                </Table.Cell>
                <Table.Cell>
                  <span className="font-mono text-[11px]">—</span>
                </Table.Cell>
              </Table.Row>
            </Table.Body>
          </Table>
        </LayerCard>
      </Section>
      <Section
        title="Inbox items"
        note="Every code and link the emulator would have sent, in real time. Each item opens the link or copies the code in one click."
      >
        <div className="grid gap-2">
          {[
            {
              icon: EnvelopeSimpleIcon,
              kind: 'Verify email',
              to: 'ada@example.test',
              value: 'Open link',
              age: 'just now',
              code: false,
            },
            {
              icon: PhoneIcon,
              kind: 'SMS code',
              to: '+1 555 0100',
              value: '482 913',
              age: '1 min ago',
              code: true,
            },
            {
              icon: EnvelopeSimpleIcon,
              kind: 'Password reset',
              to: 'rk@example.test',
              value: 'Open link',
              age: '14:02',
              code: false,
            },
          ].map((item) => (
            <div
              key={item.kind + item.to}
              className="flex items-center gap-3 rounded-lg bg-kumo-base px-4 py-3 ring ring-kumo-hairline"
            >
              <span className="h-lh flex items-center text-kumo-subtle">
                <item.icon size={16} />
              </span>
              <span className="grid">
                <span className="text-[13px] font-medium">{item.kind}</span>
                <span className="text-[12px] text-kumo-subtle">to {item.to}</span>
              </span>
              <span className="ml-auto flex items-center gap-3">
                <span className="text-[12px] text-kumo-subtle">{item.age}</span>
                {item.code ? (
                  <InlineCopyText value={item.value} className="font-mono text-[14px] font-medium">
                    {item.value}
                  </InlineCopyText>
                ) : (
                  <Button variant="secondary" size="sm" icon={<ArrowSquareOutIcon />}>
                    {item.value}
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      </Section>
      <Section
        title="Sign-in timeline"
        note="Each attempt with its outcome and the exact reason the engine produced."
      >
        <div className="grid gap-0 divide-y divide-kumo-hairline rounded-lg bg-kumo-base px-4 ring ring-kumo-hairline">
          {[
            {
              time: '10:14:02',
              what: 'signInWithPassword',
              who: 'ada@example.test',
              ok: true,
              note: 'session cookie issued',
            },
            {
              time: '10:13:48',
              what: 'signInWithPassword',
              who: 'ada@example.test',
              ok: false,
              note: 'INVALID_PASSWORD',
            },
            {
              time: '09:58:10',
              what: 'beforeSignIn',
              who: '+1 555 0100',
              ok: false,
              note: 'blocked by beforeSignIn: region not allowed',
            },
          ].map((event) => (
            <div key={event.time} className="flex items-center gap-3 py-2.5">
              <span className="w-16 font-mono text-[11px] text-kumo-subtle">{event.time}</span>
              <Badge variant={event.ok ? 'success' : 'error'} appearance="dot">
                {event.ok ? 'allowed' : 'denied'}
              </Badge>
              <span className="font-mono text-[12px]">{event.what}</span>
              <span className="text-[13px] text-kumo-subtle">{event.who}</span>
              <span className="ml-auto text-[12px] text-kumo-subtle">{event.note}</span>
            </div>
          ))}
        </div>
      </Section>
    </Stack>
  )
}

function StatusVocabulary() {
  return (
    <Stack>
      <Section
        title="Engine and services"
        note="The status bar and the overview share one vocabulary."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="neutral" appearance="dot">
            connecting
          </Badge>
          <Badge variant="success" appearance="dot">
            engine 0.2.0
          </Badge>
          <Badge variant="error" appearance="dot">
            engine unreachable
          </Badge>
          <Badge variant="success" appearance="dot">
            listening
          </Badge>
          <Badge variant="neutral" appearance="dot">
            dependency
          </Badge>
          <Badge variant="neutral" appearance="dot">
            not running
          </Badge>
          <Badge variant="warning" appearance="dot">
            reloading
          </Badge>
        </div>
      </Section>
      <Section
        title="Live"
        note="No polling. The live dot means the console channel is connected; the counter shows changes since the view opened. A changed row flashes on the success tint and settles."
      >
        <div className="flex flex-wrap items-center gap-6">
          <LiveDot />
          <LiveDot changes={12} />
          <span className="flex items-center gap-1.5 text-sm text-kumo-subtle">
            <span className="inline-flex size-2 rounded-full bg-kumo-warning" />
            reconnecting
          </span>
          <span className="rounded-md bg-kumo-success-tint px-2 py-1 font-mono text-[12px]">
            o_20251 changed
          </span>
        </div>
      </Section>
      <Section
        title="Rules and requests"
        note="Allow and deny with the rule line that decided it; coverage as a pill."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="success" appearance="dot">
            allowed
          </Badge>
          <Badge variant="error" appearance="dot">
            denied
          </Badge>
          <span className="font-mono text-[12px]">firestore.rules:14</span>
          <Badge variant="info">coverage 82%</Badge>
          <Badge variant="outline" icon={<FunnelSimpleIcon />}>
            scoped to orders
          </Badge>
        </div>
      </Section>
    </Stack>
  )
}

function SchemaTree() {
  return (
    <Stack>
      <Section
        title="Schema panel"
        note="The Firestore panel: the database, a filter, and the shape of the database as a tree of patterns with live counts from the engine's schema index. Only the path to where you are is open; a closed root shows how many subcollections wait below it, and the filter keeps matching ids with the way to them. A root opens as a grid; a nested pattern opens as the collection group it names, so every order in every user is one click. The row for where you are carries the brand bar; the foot says what that shape holds and how many parents carry it."
      >
        <div className="flex gap-3">
          <div className="flex h-[400px] w-[264px] shrink-0 flex-col overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
            <PanelHead />
            <div className="min-h-0 flex-1 overflow-hidden">
              <SchemaTreeRows rows={SHELL_SHAPE} />
            </div>
            <div className="grid shrink-0 gap-0.5 border-t border-kumo-line px-3 py-1.5">
              <span className="font-mono text-[11px] text-kumo-subtle">users/*/orders</span>
              <span className="text-[12px] text-kumo-default tabular-nums">
                12,340 documents{' '}
                <span className="text-kumo-subtle">
                  in 4,100 of 211,260 <span className="font-mono text-[11px]">users</span>
                </span>
              </span>
              <span className="text-[12px] text-kumo-subtle">
                The group also covers <span className="font-mono text-[11px]">shops/*/orders</span>
              </span>
            </div>
          </div>
          <div className="grid flex-1 content-start gap-3">
            <div className="flex h-11 items-center gap-1 rounded-lg bg-kumo-base px-3 ring ring-kumo-line">
              <PathSegment label="(default)" />
              <span className="px-0.5 text-kumo-inactive">/</span>
              <PathSegment label="users" count="211,260" />
              <span className="px-0.5 text-kumo-inactive">/</span>
              <span className="px-1.5 font-mono text-[13px] text-kumo-inactive">*</span>
              <span className="px-0.5 text-kumo-inactive">/</span>
              <PathSegment label="orders" count="12,340" current />
              <span className="ml-auto">
                <Badge variant="outline">group</Badge>
              </span>
            </div>
            <Text variant="secondary" size="sm">
              The path bar reads the same tree: a pattern shows its <code>*</code> for any document
              and each collection segment carries its count. What lives below the current collection
              is open in the panel.
            </Text>
            <LayerCard className="p-0">
              <Table>
                <Table.Header variant="compact">
                  <Table.Row>
                    <TypeHead label="id" type="doc" />
                    <Table.Head>
                      <span className="flex items-center gap-1.5 text-kumo-subtle">
                        <FolderIcon size={13} />
                        <span className="font-mono text-[12px] font-medium">subcollections</span>
                      </span>
                    </Table.Head>
                    <TypeHead label="email" type="string" />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {[
                    {
                      id: 'u_9f3k2',
                      subs: [
                        ['orders', '5'],
                        ['sessions', '2'],
                      ],
                      email: 'ada@example.test',
                    },
                    { id: 'u_2fc4c', subs: [['orders', '3']], email: 'linus@example.test' },
                    { id: 'u_2s5rh', subs: [], email: 'grace@example.test' },
                  ].map((row) => (
                    <Table.Row key={row.id}>
                      <Table.Cell>
                        <span className="font-mono text-[12px]">{row.id}</span>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="flex items-center gap-1">
                          {row.subs.map(([id, count]) => (
                            <span
                              key={id}
                              className="flex h-5 items-center gap-1 rounded bg-kumo-tint pr-1.5 pl-1 font-mono text-[11px] text-kumo-default"
                            >
                              <FolderIcon size={11} className="text-kumo-subtle" />
                              {id}
                              <span className="text-kumo-subtle tabular-nums">{count}</span>
                            </span>
                          ))}
                        </span>
                      </Table.Cell>
                      <Table.Cell>{row.email}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </LayerCard>
            <Text variant="secondary" size="sm">
              In the grid, a document's subcollections are named chips in their own column, each a
              link straight in. The column exists when the schema says documents here can hold
              subcollections; each rendered row asks which ones it actually has.
            </Text>
          </div>
        </div>
      </Section>
    </Stack>
  )
}

const RULES_SOURCE = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /users/{uid} {',
  '      allow read: if request.auth != null && request.auth.uid == uid;',
  '      allow write: if false;',
  '    }',
  '  }',
  '}',
]

/** The rules, as text, with a numbered gutter and a place for problems. */
function RulesEditorCard() {
  return (
    <Stack>
      <Section
        title="Rules as text"
        note="Apply puts them in force from the next request; Save also writes the file the project configures, which is named so nothing is written by surprise."
      >
        <div className="overflow-hidden rounded-lg border border-kumo-line">
          <div className="flex h-11 items-center gap-2 border-b border-kumo-line bg-kumo-base pr-2 pl-3">
            <Button variant="ghost" size="sm">
              Data
            </Button>
            <span className="mx-0.5 h-5 w-px shrink-0 bg-kumo-line" />
            <span className="flex items-center gap-2">
              <span className="text-kumo-subtle">
                <ShieldCheckIcon size={16} />
              </span>
              <Text as="span" size="sm" bold>
                Rules
              </Text>
              <Text as="span" variant="secondary" size="sm">
                (default)
              </Text>
            </span>
            <Badge variant="outline">unsaved</Badge>
            <span className="ml-auto flex items-center gap-2">
              <span className="font-mono text-[11px] text-kumo-subtle">firestore.rules</span>
              <Button variant="ghost" size="sm">
                Revert
              </Button>
              <Button variant="secondary" size="sm">
                Apply
              </Button>
              <Button variant="primary" size="sm">
                Save
              </Button>
            </span>
          </div>
          <div className="flex">
            <pre className="shrink-0 border-r border-kumo-hairline bg-kumo-base px-2 py-3 text-right font-mono text-[12px] leading-5 text-kumo-inactive tabular-nums">
              {RULES_SOURCE.map((_, index) => index + 1).join('\n')}
            </pre>
            <pre className="min-w-0 flex-1 bg-kumo-canvas px-3 py-3 font-mono text-[12px] leading-5 text-kumo-default">
              {RULES_SOURCE.join('\n')}
            </pre>
          </div>
          <ul className="border-t border-kumo-danger bg-kumo-danger-tint">
            <li className="flex items-start gap-2 px-3 py-1.5">
              <span className="flex h-lh shrink-0 items-center text-kumo-danger">
                <WarningIcon size={14} />
              </span>
              <span className="font-mono text-[12px] text-kumo-default">
                8:2 expected end of rules source
              </span>
            </li>
          </ul>
          <div className="flex h-9 items-center border-t border-kumo-line px-3">
            <Text variant="secondary" size="sm" as="span">
              Apply puts these rules in force from the next request. Save also writes the file.
            </Text>
          </div>
        </div>
      </Section>
    </Stack>
  )
}

/** One commit in the recent-changes list. */
function ChangeRow({
  summary,
  when,
  documents,
  more,
  undone = false,
  blocked = false,
}: {
  summary: string
  when: string
  documents: ReadonlyArray<[string, 'created' | 'updated' | 'deleted']>
  more?: number
  undone?: boolean
  blocked?: boolean
}) {
  return (
    <li className="grid gap-1 rounded-md px-1 py-1.5 hover:bg-kumo-tint">
      <div className="flex items-center gap-2">
        <Text as="span" size="sm">
          {summary}
        </Text>
        {undone ? <Badge variant="outline">undone</Badge> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <Text as="span" variant="secondary" size="sm">
            {when}
          </Text>
          <Button
            variant="ghost"
            size="xs"
            icon={<ArrowCounterClockwiseIcon />}
            disabled={undone || blocked}
          >
            Undo
          </Button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {documents.map(([id, kind]) => (
          <span
            key={id}
            className="flex h-5 items-center gap-1 rounded bg-kumo-control px-1.5 font-mono text-[11px] text-kumo-default"
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                kind === 'created'
                  ? 'bg-kumo-success'
                  : kind === 'deleted'
                    ? 'bg-kumo-danger'
                    : 'bg-kumo-warning'
              }`}
            />
            {id}
          </span>
        ))}
        {more ? (
          <Text as="span" variant="secondary" size="sm">
            +{more}
          </Text>
        ) : null}
      </div>
    </li>
  )
}

/** Recent changes, hanging off the live indicator. */
function RecentChanges() {
  return (
    <Stack>
      <Section
        title="What just happened, and putting it back"
        note="Every write the emulator accepted — the console's own, the app's, a trigger's. A dot per document says created, updated or deleted."
      >
        <div className="w-[440px] rounded-lg border border-kumo-line bg-kumo-base p-3 shadow-sm">
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <Text variant="heading" as="h3">
                Recent changes
              </Text>
              <Text variant="secondary" size="sm">
                38 kept
              </Text>
            </div>
            <ul className="-mx-1 grid gap-0.5">
              <ChangeRow
                summary="Undid an earlier change"
                when="just now"
                documents={[['u_9f3k2', 'updated']]}
              />
              <ChangeRow
                summary="1 updated"
                when="12s ago"
                documents={[['u_9f3k2', 'updated']]}
                undone
              />
              <ChangeRow
                summary="2 created, 1 deleted"
                when="1m ago"
                documents={[
                  ['o_20251', 'created'],
                  ['o_20250', 'created'],
                  ['o_19004', 'deleted'],
                ]}
              />
              <ChangeRow
                summary="200 created"
                when="4m ago"
                documents={[
                  ['it_3sygb', 'created'],
                  ['it_t83wf', 'created'],
                  ['it_g9jmx', 'created'],
                ]}
                more={197}
                blocked
              />
            </ul>
          </div>
        </div>
      </Section>
    </Stack>
  )
}

/** The export dialog's body, in one of the states it is met in. */
function ExportDialogBody({
  scope,
  note,
  progress,
  typed,
}: {
  scope: string
  note: string
  progress?: string
  typed?: boolean
}) {
  return (
    <div className="grid gap-4 rounded-lg border border-kumo-line bg-kumo-base p-5">
      <div className="grid gap-1.5">
        <Text variant="heading" size="lg" as="h3">
          Export
        </Text>
        <Text variant="secondary" size="sm">
          {scope}, read whole — not the shortened values the grid draws. {note}
        </Text>
      </div>
      <Tabs
        size="sm"
        variant="segmented"
        tabs={[
          { value: 'json', label: 'JSON' },
          { value: 'ndjson', label: 'NDJSON' },
          { value: 'csv', label: 'CSV' },
        ]}
        selectedValue={typed === undefined ? 'csv' : 'json'}
      />
      <Text variant="secondary" size="sm">
        {typed === undefined
          ? 'Flattened columns for a spreadsheet; nested keys join with a dot.'
          : 'One object keyed by document id — the shape this console imports.'}
      </Text>
      {typed === undefined ? null : (
        <div className="grid gap-1">
          <Checkbox label="Keep Firestore types exactly" checked={typed} />
          <span className="pl-6">
            <Text variant="secondary" size="sm">
              The REST wire shape. References, bytes, geopoints and vectors have no plain-JSON form
              that survives a round trip.
            </Text>
          </span>
        </div>
      )}
      {progress ? (
        <Text variant="secondary" size="sm">
          {progress}
        </Text>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary">{progress ? 'Stop' : 'Cancel'}</Button>
        <Button variant="primary" icon={<DownloadSimpleIcon />}>
          Export {typed === undefined ? 'CSV' : 'JSON'}
        </Button>
      </div>
    </div>
  )
}

/** The export dialog: what will be written, before anything is. */
function ExportDialogCard() {
  return (
    <Stack>
      <Section
        title="A whole collection"
        note="The scope is named in words, and so is whose view it is."
      >
        <ExportDialogBody
          scope="every document in users"
          note="Rules are bypassed, so this is everything the engine holds."
          typed={false}
        />
      </Section>
      <Section
        title="A query, as a spreadsheet, while it runs"
        note="A long export reports what it has read and can be stopped."
      >
        <ExportDialogBody
          scope={'every document matching where("plan", "==", "pro")'}
          note="Security rules apply, so this is what the identity you are viewing as can read."
          progress="Read 4,500…"
        />
      </Section>
    </Stack>
  )
}

/** One figure in the plan's row of facts. */
function PlanFact({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <span className="flex items-baseline gap-1 text-[13px]">
      <span className="text-kumo-subtle">{label}</span>
      <span className={`text-kumo-default tabular-nums ${mono ? 'font-mono text-[0.92em]' : ''}`}>
        {value}
      </span>
    </span>
  )
}

/** The plan itself: the sentence, the figures, and whatever card follows. */
function PlanPanel({ headline, children }: { headline: string; children?: ReactNode }) {
  return (
    <div className="grid gap-3 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="flex h-lh shrink-0 items-center text-kumo-subtle">
          <LightningIcon size={16} />
        </span>
        <div className="grid min-w-0 flex-1 gap-1.5">
          <Text size="sm" as="p">
            {headline}
          </Text>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <PlanFact label="matched" value="240 documents" />
            <PlanFact label="took" value="2.9 ms" />
            <PlanFact label="results" value="streamed" />
            <PlanFact label="ordered by" value="__name__ asc" mono />
          </div>
        </div>
        <Button variant="ghost" size="sm" icon={<XIcon />} aria-label="Close the query plan" />
      </div>
      {children}
    </div>
  )
}

/** The index spelled out as the entry it would become, with its action. */
function PlanIndexFields({
  fields,
  copy = false,
}: {
  fields: ReadonlyArray<[string, string]>
  copy?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[12px] text-kumo-subtle">users</span>
        {fields.map(([name, mark]) => (
          <span
            key={name}
            className="flex h-5 items-center rounded bg-kumo-base px-1.5 font-mono text-[11px] text-kumo-default"
          >
            {name}
            <span className="pl-1 text-kumo-subtle">{mark}</span>
          </span>
        ))}
      </div>
      {copy ? (
        <Button variant="secondary" size="sm" icon={<CopyIcon />}>
          Copy entry
        </Button>
      ) : null}
    </div>
  )
}

/** The query plan, in the three states a person meets it in. */
function QueryPlan() {
  return (
    <Stack>
      <Section
        title="Nothing to declare"
        note="A query production indexes by itself: the plan alone, no card."
      >
        <PlanPanel headline="Reads every document in users" />
      </Section>
      <Section
        title="The index is declared"
        note="Confirmed quietly, in success tint, with nothing to do and nothing to copy."
      >
        <PlanPanel headline="Narrows users by the plan index">
          <div className="grid gap-2 rounded-md bg-kumo-success-tint p-2.5 ring ring-kumo-hairline">
            <div className="flex items-start gap-2">
              <span className="flex h-lh shrink-0 items-center text-kumo-subtle">
                <CheckCircleIcon size={16} />
              </span>
              <div className="grid min-w-0 flex-1 gap-1.5">
                <Text size="sm" as="p">
                  firestore.indexes.json declares the composite index this query needs.
                </Text>
                <PlanIndexFields
                  fields={[
                    ['plan', '↑'],
                    ['lastSeen', '↓'],
                  ]}
                />
              </div>
            </div>
          </div>
        </PlanPanel>
      </Section>
      <Section
        title="The index is missing"
        note="The one state that needs acting on: warning tint, a warning ring, and the entry to paste."
      >
        <PlanPanel headline="Narrows users by the plan index">
          <div className="grid gap-2 rounded-md bg-kumo-warning-tint p-2.5 ring ring-kumo-warning">
            <div className="flex items-start gap-2">
              <span className="flex h-lh shrink-0 items-center text-kumo-subtle">
                <WarningIcon size={16} />
              </span>
              <div className="grid min-w-0 flex-1 gap-1.5">
                <Text size="sm" as="p">
                  Production needs a composite index for this query. The emulator answers it either
                  way, so it would fail after a deploy, not here.
                </Text>
                <PlanIndexFields
                  copy
                  fields={[
                    ['plan', '↑'],
                    ['displayName', '↑'],
                  ]}
                />
              </div>
            </div>
          </div>
        </PlanPanel>
      </Section>
    </Stack>
  )
}

defineCards([
  {
    id: 'app-shell',
    group: 'Patterns',
    name: 'App shell',
    subtitle:
      'Navigation expanded or collapsed with peek on hover; the section panel beside the content; project and engine in the bar',
    width: 1280,
    surface: 'canvas',
    render: () => <Shell />,
  },
  {
    id: 'path-and-query',
    group: 'Patterns',
    name: 'Path bar and query bar',
    subtitle: 'Linked segments with counts, clause chips, live count, explain, view as user',
    width: 1100,
    surface: 'canvas',
    render: () => <PathAndQuery />,
  },
  {
    id: 'query-plan',
    group: 'Patterns',
    name: 'Query plan',
    subtitle:
      'What the query reads, how long it took, and the index production would require — quiet when declared, a warning with a copyable entry when not',
    width: 880,
    surface: 'canvas',
    render: () => <QueryPlan />,
  },
  {
    id: 'rules-editor',
    group: 'Patterns',
    name: 'Rules editor',
    subtitle:
      'The security rules as text, with a numbered gutter, the file it saves to named, and compiler problems placed in the source',
    width: 900,
    surface: 'canvas',
    render: () => <RulesEditorCard />,
  },
  {
    id: 'recent-changes',
    group: 'Patterns',
    name: 'Recent changes',
    subtitle:
      'The window of commits the engine keeps, each with the documents it touched and an undo that restores exactly what it replaced',
    width: 520,
    surface: 'canvas',
    render: () => <RecentChanges />,
  },
  {
    id: 'export-dialog',
    group: 'Patterns',
    name: 'Export dialog',
    subtitle:
      'What will be written before anything is: the scope in words, whose view it is, the format, and progress that can be stopped',
    width: 720,
    surface: 'canvas',
    render: () => <ExportDialogCard />,
  },
  {
    id: 'data-grid',
    group: 'Patterns',
    name: 'Data grid',
    subtitle:
      'Typed columns, copyable ids, references, relative time, denied and missing rows, flash on change',
    width: 1100,
    surface: 'canvas',
    render: () => <DataGrid />,
  },
  {
    id: 'schema-tree',
    group: 'Patterns',
    name: 'Schema panel and subcollections',
    subtitle:
      'The database as a tree of patterns with live counts, open along your path, filterable; pattern paths in the path bar; named subcollection chips per row',
    width: 1100,
    surface: 'canvas',
    render: () => <SchemaTree />,
  },
  {
    id: 'inspector',
    group: 'Patterns',
    name: 'Document inspector',
    subtitle:
      'The recursive field row, an editor per type, rename and removal, JSON, subcollections',
    width: 880,
    surface: 'canvas',
    render: () => <Inspector />,
  },
  {
    id: 'auth-patterns',
    group: 'Patterns',
    name: 'Auth rows, inbox, timeline',
    subtitle:
      'User identity rows, the codes-and-links inbox, sign-in attempts with the exact reason',
    width: 1100,
    surface: 'canvas',
    render: () => <AuthPatterns />,
  },
  {
    id: 'status-live',
    group: 'Patterns',
    name: 'Status and live vocabulary',
    subtitle: 'Engine, service, live, rules and coverage states',
    width: 880,
    render: () => <StatusVocabulary />,
  },
])
