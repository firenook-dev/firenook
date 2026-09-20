import {
  Badge,
  Button,
  Collapsible,
  InlineCopyText,
  Input,
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
  ArrowSquareOutIcon,
  BracketsCurlyIcon,
  CaretRightIcon,
  CommandIcon,
  CopyIcon,
  DatabaseIcon,
  EnvelopeSimpleIcon,
  FunnelSimpleIcon,
  GaugeIcon,
  GoogleLogoIcon,
  KeyIcon,
  LockSimpleIcon,
  PasswordIcon,
  PhoneIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
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

function Shell() {
  return (
    <TooltipProvider>
      <div className="flex h-[720px] w-full overflow-hidden rounded-lg ring ring-kumo-hairline">
        <Sidebar.Provider contained defaultOpen className="h-full min-h-0!">
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
          <div className="flex min-w-0 flex-1 flex-col bg-kumo-canvas">
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-kumo-line bg-kumo-base px-4">
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
            <main className="min-h-0 flex-1 overflow-auto px-6 py-5">
              <div className="grid gap-1.5">
                <div className="flex items-center gap-2">
                  <Text variant="heading" size="lg" as="h1">
                    Firestore
                  </Text>
                  <Badge variant="success" appearance="dot">
                    running
                  </Badge>
                </div>
                <Text variant="secondary">Content area. Sections render here at full width.</Text>
              </div>
            </main>
          </div>
        </Sidebar.Provider>
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
              <Switch variant="neutral" label="Explain" size="sm" />
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

function TypeHead({
  label,
  type,
  variant,
}: {
  label: string
  type: string
  variant: 'blue' | 'teal' | 'purple' | 'orange' | 'green' | 'neutral'
}) {
  return (
    <Table.Head>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[12px] font-medium">{label}</span>
        <Badge variant={variant}>{type}</Badge>
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
                <TypeHead label="id" type="doc" variant="neutral" />
                <TypeHead label="status" type="string" variant="blue" />
                <TypeHead label="total" type="number" variant="teal" />
                <TypeHead label="createdAt" type="timestamp" variant="purple" />
                <TypeHead label="customer" type="reference" variant="orange" />
                <TypeHead label="items" type="array" variant="neutral" />
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

function Field({
  name,
  type,
  variant,
  children,
}: {
  name: string
  type: string
  variant: 'blue' | 'teal' | 'purple' | 'orange' | 'green' | 'neutral'
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-center gap-3 py-1.5">
      <span className="flex items-center gap-2">
        <span className="font-mono text-[13px]">{name}</span>
        <Badge variant={variant}>{type}</Badge>
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function Inspector() {
  return (
    <Stack>
      <Section
        title="Inspector"
        note="The selected document, edited in place with a typed editor per field. Fields or JSON. Subcollections beneath with counts. Copy as code emits the read or write in the SDK dialect the developer chooses."
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
            <div className="grid divide-y divide-kumo-hairline">
              <Field name="status" type="string" variant="blue">
                <Input size="sm" defaultValue="paid" />
              </Field>
              <Field name="total" type="number" variant="teal">
                <Input size="sm" defaultValue="42" className="w-40 font-mono" />
              </Field>
              <Field name="paid" type="boolean" variant="green">
                <Switch
                  variant="neutral"
                  size="sm"
                  checked
                  onCheckedChange={() => {}}
                  label="true"
                />
              </Field>
              <Field name="createdAt" type="timestamp" variant="purple">
                <Input size="sm" defaultValue="2026-09-20T10:14:02.117Z" className="font-mono" />
              </Field>
              <Field name="customer" type="reference" variant="orange">
                <Link href="#" className="font-mono text-[0.9em]">
                  users/u_9f3k2
                </Link>
              </Field>
              <Field name="items" type="array" variant="neutral">
                <Collapsible.Root defaultOpen={false}>
                  <Collapsible.DefaultTrigger>3 items</Collapsible.DefaultTrigger>
                  <Collapsible.DefaultPanel>
                    <span className="font-mono text-[12px] text-kumo-subtle">
                      [ sku_1, sku_9, sku_12 ]
                    </span>
                  </Collapsible.DefaultPanel>
                </Collapsible.Root>
              </Field>
            </div>
            <Button variant="ghost" size="sm" icon={<PlusIcon />} className="justify-self-start">
              Add field
            </Button>
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

defineCards([
  {
    id: 'app-shell',
    group: 'Patterns',
    name: 'App shell',
    subtitle: 'Sidebar by area, project and engine in the bar, content at full width',
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
    id: 'inspector',
    group: 'Patterns',
    name: 'Document inspector',
    subtitle: 'Typed field editors, JSON tab, subcollections, save, copy as code, delete',
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
