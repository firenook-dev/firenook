import {
  Badge,
  Banner,
  Breadcrumbs,
  Button,
  Checkbox,
  ClipboardText,
  Code,
  Collapsible,
  CommandPalette,
  Dialog,
  DropdownMenu,
  Empty,
  InlineCopyText,
  Input,
  InputArea,
  LayerCard,
  Link,
  Loader,
  MenuBar,
  Meter,
  Pagination,
  Popover,
  Radio,
  Select,
  SensitiveInput,
  Sidebar,
  Switch,
  Table,
  Tabs,
  Text,
  Toasty,
  Toolbar,
  Tooltip,
  TooltipProvider,
  useKumoToastManager,
} from '@cloudflare/kumo'
import {
  ArrowsClockwiseIcon,
  DatabaseIcon,
  DownloadIcon,
  FunnelSimpleIcon,
  GaugeIcon,
  HouseIcon,
  InfoIcon,
  KeyIcon,
  PlusIcon,
  ScrollIcon,
  TrashIcon,
  UsersIcon,
  WarningCircleIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { defineCards } from '../registry'
import { Row, Section, Stack } from './shared'

const BUTTON_VARIANTS = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'secondary-destructive',
] as const
const BUTTON_SIZES = ['xs', 'sm', 'base', 'lg'] as const

function Buttons() {
  return (
    <Stack>
      <Section
        title="Variants"
        note="One primary per view. Secondary for the rest, ghost inside tables and toolbars, destructive only for deletes."
      >
        <Row label="filled">
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
        </Row>
        <Row label="with icon">
          <Button variant="primary" icon={<PlusIcon />}>
            Add document
          </Button>
          <Button variant="secondary" icon={<DownloadIcon />}>
            Export
          </Button>
          <Button variant="ghost" icon={<ArrowsClockwiseIcon />}>
            Reload rules
          </Button>
          <Button variant="destructive" icon={<TrashIcon />}>
            Delete 3 documents
          </Button>
        </Row>
        <Row label="icon only">
          <Button shape="square" icon={<PlusIcon />} aria-label="Add" />
          <Button
            shape="square"
            variant="secondary"
            icon={<FunnelSimpleIcon />}
            aria-label="Filter"
          />
          <Button shape="square" variant="ghost" icon={<XIcon />} aria-label="Close" />
          <Button shape="circle" variant="secondary" icon={<KeyIcon />} aria-label="Mint token" />
        </Row>
        <Row label="states">
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
        </Row>
      </Section>
      <Section
        title="Sizes"
        note="xs 20 px, sm 26 px, base 36 px, lg 40 px. Tables and toolbars use sm."
      >
        {BUTTON_SIZES.map((size) => (
          <Row key={size} label={size}>
            <Button size={size}>Primary</Button>
            <Button size={size} variant="secondary">
              Secondary
            </Button>
            <Button size={size} variant="ghost" icon={<ArrowsClockwiseIcon />}>
              Refresh
            </Button>
            <Button size={size} shape="square" icon={<PlusIcon />} aria-label="Add" />
          </Row>
        ))}
      </Section>
    </Stack>
  )
}

function Badges() {
  return (
    <Stack>
      <Section
        title="Semantic"
        note="Filled for labels, dot for status. A dot badge names a state the reader checks at a glance."
      >
        <Row label="filled">
          <Badge variant="primary">primary</Badge>
          <Badge variant="secondary">secondary</Badge>
          <Badge variant="info">info</Badge>
          <Badge variant="success">success</Badge>
          <Badge variant="warning">warning</Badge>
          <Badge variant="error">error</Badge>
          <Badge variant="outline">outline</Badge>
          <Badge variant="beta">beta</Badge>
        </Row>
        <Row label="dot">
          <Badge variant="success" appearance="dot">
            listening
          </Badge>
          <Badge variant="neutral" appearance="dot">
            not running
          </Badge>
          <Badge variant="warning" appearance="dot">
            reloading
          </Badge>
          <Badge variant="error" appearance="dot">
            engine unreachable
          </Badge>
        </Row>
        <Row label="with icon">
          <Badge variant="info" icon={<InfoIcon />}>
            info
          </Badge>
          <Badge variant="error" icon={<WarningCircleIcon />}>
            denied
          </Badge>
        </Row>
      </Section>
      <Section
        title="Value types"
        note="The Firestore grid tags every column with its value type using the colour tokens."
      >
        <Row label="types">
          <Badge variant="blue">string</Badge>
          <Badge variant="teal">number</Badge>
          <Badge variant="purple">timestamp</Badge>
          <Badge variant="orange">reference</Badge>
          <Badge variant="green">boolean</Badge>
          <Badge variant="neutral">map</Badge>
          <Badge variant="neutral">array</Badge>
          <Badge variant="red">null</Badge>
        </Row>
      </Section>
    </Stack>
  )
}

function Inputs() {
  return (
    <Stack>
      <Section
        title="Text"
        note="Sizes match Button. The error variant carries its message in the field."
      >
        <Row label="base">
          <Input label="Collection id" placeholder="users" className="w-64" />
          <Input
            label="Email"
            description="Used as the sign-in identifier"
            defaultValue="ada@example.test"
            className="w-64"
          />
        </Row>
        <Row label="error">
          <Input
            label="Document id"
            variant="error"
            error="An id cannot contain a slash"
            defaultValue="u/9f3k2"
            className="w-64"
          />
        </Row>
        <Row label="sm">
          <Input size="sm" placeholder="Search users" className="w-64" />
          <Input size="sm" placeholder="Filter by email, phone or uid" className="w-72" />
        </Row>
        <Row label="secret">
          <SensitiveInput
            label="Custom token"
            defaultValue="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9"
            className="w-96"
          />
        </Row>
        <Row label="area">
          <InputArea
            label="Custom claims"
            defaultValue={'{ "role": "admin" }'}
            minRows={3}
            className="w-96"
          />
        </Row>
      </Section>
      <Section title="Select">
        <Row label="closed">
          <Select
            label="Database"
            hideLabel={false}
            defaultValue="(default)"
            items={{ '(default)': '(default)', analytics: 'analytics', staging: 'staging' }}
            className="w-56"
          />
          <Select
            label="View as"
            hideLabel={false}
            defaultValue="anonymous"
            items={{ anonymous: 'Anonymous', u_9f3k2: 'ada@example.test', admin: 'Admin SDK' }}
            className="w-56"
          />
        </Row>
      </Section>
      <Section title="Choice">
        <Row label="checkbox">
          <Checkbox label="Email verified" checked onCheckedChange={() => {}} />
          <Checkbox label="Disabled" />
          <Checkbox label="Some selected" indeterminate />
        </Row>
        <Row label="switch">
          <Switch variant="neutral" label="Live updates" checked onCheckedChange={() => {}} />
          <Switch variant="neutral" label="Show missing documents" />
          <Switch
            variant="neutral"
            label="Compact rows"
            size="sm"
            checked
            onCheckedChange={() => {}}
          />
        </Row>
        <Row label="radio">
          <Radio.Group legend="Order" orientation="horizontal" defaultValue="asc">
            <Radio.Item label="Ascending" value="asc" />
            <Radio.Item label="Descending" value="desc" />
          </Radio.Group>
        </Row>
      </Section>
    </Stack>
  )
}

function TabsAndNav() {
  return (
    <Stack>
      <Section
        title="Tabs"
        note="Segmented for view modes inside a panel, underline for sections of a page."
      >
        <Row label="segmented">
          <Tabs
            variant="segmented"
            tabs={[
              { value: 'table', label: 'Table' },
              { value: 'json', label: 'JSON' },
              { value: 'requests', label: 'Requests' },
            ]}
            selectedValue="table"
          />
          <Tabs
            variant="segmented"
            size="sm"
            tabs={[
              { value: 'form', label: 'Form' },
              { value: 'text', label: 'Text' },
            ]}
            selectedValue="form"
          />
        </Row>
        <Row label="underline">
          <Tabs
            variant="underline"
            tabs={[
              { value: 'users', label: 'Users' },
              { value: 'inbox', label: 'Inbox' },
              { value: 'signins', label: 'Sign-ins' },
              { value: 'providers', label: 'Providers' },
              { value: 'tenants', label: 'Tenants' },
            ]}
            selectedValue="users"
          />
        </Row>
      </Section>
      <Section title="Breadcrumbs and links">
        <Row label="breadcrumbs">
          <Breadcrumbs>
            <Breadcrumbs.Link href="#" icon={<DatabaseIcon size={16} />}>
              Firestore
            </Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Link href="#">users</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Link href="#">u_9f3k2</Breadcrumbs.Link>
            <Breadcrumbs.Separator />
            <Breadcrumbs.Current>orders</Breadcrumbs.Current>
          </Breadcrumbs>
        </Row>
        <Row label="links">
          <Link href="#">inline link</Link>
          <Link href="#" variant="plain">
            plain link
          </Link>
          <Link href="#" variant="current">
            current
          </Link>
        </Row>
      </Section>
      <Section title="Pagination">
        <Row label="full">
          <Pagination page={3} setPage={() => {}} perPage={50} totalCount={12_345} />
        </Row>
        <Row label="simple">
          <Pagination
            page={1}
            setPage={() => {}}
            perPage={50}
            totalCount={12_345}
            controls="simple"
          />
        </Row>
      </Section>
      <Section title="Toolbar and menu bar">
        <Row label="toolbar">
          <Toolbar className="w-[420px]">
            <Toolbar.Input aria-label="Search" placeholder="Search documents" className="flex-1" />
            <Toolbar.Button icon={FunnelSimpleIcon} aria-label="Filter" />
            <Toolbar.Button icon={ArrowsClockwiseIcon} aria-label="Refresh" />
          </Toolbar>
        </Row>
        <Row label="menu bar">
          <MenuBar
            isActive={0}
            options={[
              { icon: <GaugeIcon />, tooltip: 'Overview', onClick: () => {} },
              { icon: <DatabaseIcon />, tooltip: 'Firestore', onClick: () => {} },
              { icon: <UsersIcon />, tooltip: 'Authentication', onClick: () => {} },
              { icon: <ScrollIcon />, tooltip: 'Logs', onClick: () => {} },
            ]}
          />
        </Row>
      </Section>
    </Stack>
  )
}

const ROWS = [
  {
    id: 'o_20251',
    status: 'paid',
    total: '42.00',
    created: '2 min ago',
    customer: 'users/u_9f3k2',
  },
  { id: 'o_20250', status: 'paid', total: '18.50', created: '1 h ago', customer: 'users/u_9f3k2' },
  {
    id: 'o_20249',
    status: 'refunded',
    total: '99.00',
    created: 'yesterday',
    customer: 'users/u_1x8pq',
  },
  {
    id: 'o_20248',
    status: 'pending',
    total: '7.25',
    created: '3 days ago',
    customer: 'users/u_7c0aa',
  },
]

function TableCard() {
  return (
    <Stack>
      <Section
        title="Table"
        note="Semantic table. Rows alternate on the elevated surface; a selected row uses the tint. Ids copy on hover."
      >
        <LayerCard className="p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.CheckHead
                  checked={false}
                  indeterminate
                  onCheckedChange={() => {}}
                  aria-label="Select all"
                />
                <Table.Head>id</Table.Head>
                <Table.Head>status</Table.Head>
                <Table.Head>total</Table.Head>
                <Table.Head>createdAt</Table.Head>
                <Table.Head>customer</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {ROWS.map((row, index) => (
                <Table.Row
                  key={row.id}
                  className="group"
                  variant={index === 1 ? 'selected' : 'default'}
                >
                  <Table.CheckCell
                    checked={index === 1}
                    onCheckedChange={() => {}}
                    aria-label={`Select ${row.id}`}
                  />
                  <Table.Cell>
                    <InlineCopyText value={row.id} className="font-mono text-[0.9em]">
                      {row.id}
                    </InlineCopyText>
                  </Table.Cell>
                  <Table.Cell>
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
                  </Table.Cell>
                  <Table.Cell>
                    <span className="font-mono text-[0.9em] tabular-nums">{row.total}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <Text variant="secondary" size="sm">
                      {row.created}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Link href="#" className="font-mono text-[0.9em]">
                      {row.customer}
                    </Link>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      </Section>
      <Section
        title="Compact header"
        note="For dense grids the header shrinks to 12 px on the elevated surface."
      >
        <LayerCard className="p-0">
          <Table>
            <Table.Header variant="compact">
              <Table.Row>
                <Table.Head>identifier</Table.Head>
                <Table.Head>provider</Table.Head>
                <Table.Head>created</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              <Table.Row>
                <Table.Cell>ada@example.test</Table.Cell>
                <Table.Cell>password</Table.Cell>
                <Table.Cell>2026-09-18</Table.Cell>
              </Table.Row>
              <Table.Row>
                <Table.Cell>+1 555 0100</Table.Cell>
                <Table.Cell>phone</Table.Cell>
                <Table.Cell>2026-09-19</Table.Cell>
              </Table.Row>
            </Table.Body>
          </Table>
        </LayerCard>
      </Section>
    </Stack>
  )
}

function Surfaces() {
  return (
    <Stack>
      <Section
        title="Layer card"
        note="The one container. A secondary strip for a header, primary for the body. Never nest one in another."
      >
        <div className="flex flex-wrap gap-4">
          <LayerCard className="w-72">
            <LayerCard.Secondary className="flex items-center justify-between">
              <Text bold>users</Text>
              <Badge variant="neutral">211,260</Badge>
            </LayerCard.Secondary>
            <LayerCard.Primary>
              <Text variant="secondary">Last write 2 minutes ago by the Admin SDK.</Text>
            </LayerCard.Primary>
          </LayerCard>
          <LayerCard className="w-72 px-5 py-4">
            <div className="grid gap-1.5">
              <Text variant="heading" as="h3">
                Rules
              </Text>
              <Text variant="secondary">Reloaded 14:02:11 from firestore.rules</Text>
            </div>
          </LayerCard>
        </div>
      </Section>
      <Section title="Collapsible">
        <div className="w-96">
          <Collapsible.Root defaultOpen>
            <Collapsible.DefaultTrigger>Subcollections (2)</Collapsible.DefaultTrigger>
            <Collapsible.DefaultPanel>
              <div className="grid gap-1">
                <Link href="#" className="font-mono text-[0.9em]">
                  orders · 33
                </Link>
                <Link href="#" className="font-mono text-[0.9em]">
                  sessions · 8
                </Link>
              </div>
            </Collapsible.DefaultPanel>
          </Collapsible.Root>
        </div>
      </Section>
      <Section title="Meter and loader">
        <Row label="meter">
          <div className="w-72">
            <Meter label="Requests buffer" value={182} max={256} showValue />
          </div>
        </Row>
        <Row label="loader">
          <Loader size="sm" />
          <Loader />
          <Loader size="lg" />
        </Row>
      </Section>
    </Stack>
  )
}

function ToastOnMount({
  title,
  description,
  variant,
}: {
  title: string
  description: string
  variant: 'success' | 'info' | 'error'
}) {
  const toasts = useKumoToastManager()
  const shown = useRef(false)
  // The manager's identity changes per render and StrictMode mounts twice:
  // show the sample toast exactly once.
  useEffect(() => {
    if (shown.current) return
    shown.current = true
    toasts.add({ title, description, variant, timeout: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

function ToastBox({
  title,
  description,
  variant,
}: {
  title: string
  description: string
  variant: 'success' | 'info' | 'error'
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  return (
    <div
      ref={setBox}
      className="relative h-28 overflow-hidden rounded-lg bg-kumo-canvas ring ring-kumo-hairline [contain:paint]"
    >
      <Toasty {...(box ? { container: box } : {})}>
        <ToastOnMount title={title} description={description} variant={variant} />
        <span />
      </Toasty>
    </div>
  )
}

function Feedback() {
  return (
    <Stack>
      <Section
        title="Banner"
        note="Page-level messages. Default is informational; alert warns; error blocks; secondary is neutral."
      >
        <div className="grid gap-3">
          <Banner
            icon={<InfoIcon weight="fill" />}
            title="Demo project"
            description="No cloud service is contacted. Functions can still reach external providers."
          />
          <Banner
            icon={<WarningIcon weight="fill" />}
            variant="alert"
            title="Listening on 0.0.0.0"
            description="Every service is reachable from any device on this network."
          />
          <Banner
            icon={<WarningCircleIcon weight="fill" />}
            variant="error"
            title="Import rejected"
            description="The seed identity changed; the working state was preserved."
          />
          <Banner
            icon={<InfoIcon weight="fill" />}
            variant="secondary"
            title="Requests diagnostics"
            description="Retained history may be incomplete: 12 events omitted while busy."
          />
        </div>
      </Section>
      <Section
        title="Empty"
        note="Says what is missing and offers the one next step, with a copyable command when there is one."
      >
        <Empty
          icon={<DatabaseIcon size={48} className="text-kumo-inactive" />}
          title="No documents in orders"
          description="Write one from your app, or add a document here."
          commandLine="firenook firestore:seed orders"
          contents={
            <Button variant="primary" icon={<PlusIcon />}>
              Add document
            </Button>
          }
        />
      </Section>
      <Section
        title="Toast"
        note="Bottom right of the viewport. A toast confirms what just happened in the same words as the button."
      >
        <div className="grid grid-cols-2 gap-3">
          <ToastBox
            title="Document saved"
            description="users/u_9f3k2 at revision 4,812"
            variant="success"
          />
          <ToastBox
            title="Rules reloaded"
            description="3 changes from firestore.rules"
            variant="info"
          />
          <ToastBox
            title="Write denied"
            description="Rules line 14: request.auth is null"
            variant="error"
          />
        </div>
      </Section>
    </Stack>
  )
}

/** An open menu focuses its first item; the card is a still, so drop the ring. */
function BlurFocus() {
  useEffect(() => {
    const id = window.setTimeout(() => (document.activeElement as HTMLElement | null)?.blur(), 50)
    return () => window.clearTimeout(id)
  }, [])
  return null
}

const PALETTE_ITEMS = [
  { id: 'firestore', title: 'Firestore', icon: DatabaseIcon },
  { id: 'auth', title: 'Authentication', icon: UsersIcon },
  { id: 'logs', title: 'Logs', icon: ScrollIcon },
]

function Overlays() {
  const [search, setSearch] = useState('')
  const [dialogBox, setDialogBox] = useState<HTMLDivElement | null>(null)
  const [paletteBox, setPaletteBox] = useState<HTMLDivElement | null>(null)
  return (
    <Stack>
      <Section
        title="Dialog"
        note="Confirmations and short forms. The title says the action; the primary button repeats it."
      >
        <div
          ref={setDialogBox}
          className="relative h-72 overflow-hidden rounded-lg bg-kumo-canvas ring ring-kumo-hairline [contain:paint]"
        >
          <Dialog.Root open>
            <Dialog size="base" className="p-6" {...(dialogBox ? { container: dialogBox } : {})}>
              <div className="mb-3 flex items-start justify-between gap-4">
                <Dialog.Title className="text-lg font-semibold">Delete 3 documents</Dialog.Title>
                <Dialog.Close
                  aria-label="Close"
                  render={
                    <Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />
                  }
                />
              </div>
              <Dialog.Description className="text-kumo-subtle">
                orders/o_20249, o_20248 and o_20247 and their subcollections will be removed. Undo
                stays available for the next 5 minutes.
              </Dialog.Description>
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="secondary">Cancel</Button>
                <Button variant="destructive" icon={<TrashIcon />}>
                  Delete 3 documents
                </Button>
              </div>
            </Dialog>
          </Dialog.Root>
        </div>
      </Section>
      <Section
        title="Popover, menu, tooltip"
        note="Popovers hold a small choice; menus hold row actions, with the destructive one last and red."
      >
        <div className="grid h-64 grid-cols-3 items-start gap-6">
          <div>
            <Popover open>
              <Popover.Trigger render={<Button variant="secondary" />}>
                Copy as code
              </Popover.Trigger>
              <Popover.Content className="w-56">
                <Popover.Title>Copy as code</Popover.Title>
                <Popover.Description>The same read in the SDK you use.</Popover.Description>
                <div className="mt-3 grid gap-1">
                  <Button variant="ghost" size="sm" className="justify-start">
                    Web SDK v10
                  </Button>
                  <Button variant="ghost" size="sm" className="justify-start">
                    Admin SDK
                  </Button>
                  <Button variant="ghost" size="sm" className="justify-start">
                    REST
                  </Button>
                </div>
              </Popover.Content>
            </Popover>
          </div>
          <div>
            <DropdownMenu open>
              <DropdownMenu.Trigger
                render={
                  <Button variant="secondary" icon={<PlusIcon />}>
                    Actions
                  </Button>
                }
              />
              <DropdownMenu.Content>
                <DropdownMenu.Item icon={KeyIcon}>Mint ID token</DropdownMenu.Item>
                <DropdownMenu.Item icon={UsersIcon}>Sign in as this user</DropdownMenu.Item>
                <DropdownMenu.Item icon={DatabaseIcon}>
                  View Firestore as this user
                </DropdownMenu.Item>
                <DropdownMenu.Item icon={TrashIcon} variant="danger">
                  Delete user
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
          <div className="grid justify-items-start gap-2">
            <TooltipProvider>
              <Tooltip
                content="Reload rules from disk"
                render={
                  <Button
                    shape="square"
                    variant="secondary"
                    icon={<ArrowsClockwiseIcon />}
                    aria-label="Reload rules"
                  />
                }
              />
            </TooltipProvider>
            <Text variant="secondary" size="sm">
              Tooltip on hover: “Reload rules from disk”
            </Text>
          </div>
        </div>
        <BlurFocus />
      </Section>
      <Section
        title="Command palette"
        note="Ctrl K anywhere. Sections, documents, users and actions in one list."
      >
        <div
          ref={setPaletteBox}
          className="relative h-[440px] overflow-hidden rounded-lg bg-kumo-canvas ring ring-kumo-hairline [contain:paint]"
        >
          <CommandPalette.Root
            {...(paletteBox ? { container: paletteBox } : {})}
            open
            onOpenChange={() => {}}
            items={PALETTE_ITEMS}
            value={search}
            onValueChange={setSearch}
            itemToStringValue={(item) => item.title}
            onSelect={() => {}}
            getSelectableItems={(items) => items}
          >
            <CommandPalette.Input placeholder="Jump to a section, a path or a user…" />
            <CommandPalette.List>
              <CommandPalette.Results>
                {(item: (typeof PALETTE_ITEMS)[number]) => (
                  <CommandPalette.Item key={item.id} value={item} onClick={() => {}}>
                    <span className="flex items-center gap-3">
                      <span className="h-lh flex items-center text-kumo-subtle">
                        <item.icon size={16} />
                      </span>
                      <span>{item.title}</span>
                    </span>
                  </CommandPalette.Item>
                )}
              </CommandPalette.Results>
              <CommandPalette.Empty>Nothing matches</CommandPalette.Empty>
            </CommandPalette.List>
            <CommandPalette.Footer>
              <span className="flex items-center gap-2">
                <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-[10px]">
                  ↑↓
                </kbd>
                <span>Navigate</span>
              </span>
              <span className="flex items-center gap-2">
                <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-[10px]">
                  ↵
                </kbd>
                <span>Open</span>
              </span>
            </CommandPalette.Footer>
          </CommandPalette.Root>
        </div>
      </Section>
    </Stack>
  )
}

function SidebarCard() {
  return (
    <Stack>
      <Section
        title="Sidebar"
        note="Expanded and collapsed to icons. Groups by area; the active item is filled."
      >
        <div className="flex gap-6">
          <div className="h-[420px] w-64 overflow-hidden rounded-lg ring ring-kumo-hairline">
            <Sidebar.Provider contained defaultOpen className="h-full min-h-0!">
              <Sidebar>
                <Sidebar.Header>
                  <div className="flex items-center gap-2 px-2 py-1">
                    <span className="flex size-6 items-center justify-center rounded-md bg-kumo-brand text-white">
                      <GaugeIcon size={14} weight="bold" />
                    </span>
                    <Text bold>Firenook</Text>
                  </div>
                </Sidebar.Header>
                <Sidebar.Content>
                  <Sidebar.Group>
                    <Sidebar.Menu>
                      <Sidebar.MenuButton icon={HouseIcon}>Overview</Sidebar.MenuButton>
                    </Sidebar.Menu>
                  </Sidebar.Group>
                  <Sidebar.Group>
                    <Sidebar.GroupLabel>Data</Sidebar.GroupLabel>
                    <Sidebar.Menu>
                      <Sidebar.MenuButton icon={DatabaseIcon} active>
                        Firestore
                      </Sidebar.MenuButton>
                      <Sidebar.MenuButton icon={UsersIcon}>Authentication</Sidebar.MenuButton>
                    </Sidebar.Menu>
                  </Sidebar.Group>
                  <Sidebar.Group>
                    <Sidebar.GroupLabel>Observe</Sidebar.GroupLabel>
                    <Sidebar.Menu>
                      <Sidebar.MenuButton icon={ScrollIcon}>Logs</Sidebar.MenuButton>
                    </Sidebar.Menu>
                  </Sidebar.Group>
                </Sidebar.Content>
                <Sidebar.Footer>
                  <Sidebar.Trigger />
                </Sidebar.Footer>
              </Sidebar>
              <div className="flex-1 bg-kumo-canvas" />
            </Sidebar.Provider>
          </div>
          <div className="h-[420px] w-40 overflow-hidden rounded-lg ring ring-kumo-hairline">
            <Sidebar.Provider contained defaultOpen={false} className="h-full min-h-0!">
              <Sidebar>
                <Sidebar.Content>
                  <Sidebar.Group>
                    <Sidebar.Menu>
                      <Sidebar.MenuButton icon={HouseIcon} tooltip="Overview">
                        Overview
                      </Sidebar.MenuButton>
                      <Sidebar.MenuButton icon={DatabaseIcon} tooltip="Firestore" active>
                        Firestore
                      </Sidebar.MenuButton>
                      <Sidebar.MenuButton icon={UsersIcon} tooltip="Authentication">
                        Authentication
                      </Sidebar.MenuButton>
                      <Sidebar.MenuButton icon={ScrollIcon} tooltip="Logs">
                        Logs
                      </Sidebar.MenuButton>
                    </Sidebar.Menu>
                  </Sidebar.Group>
                </Sidebar.Content>
                <Sidebar.Footer>
                  <Sidebar.Trigger />
                </Sidebar.Footer>
              </Sidebar>
              <div className="flex-1 bg-kumo-canvas" />
            </Sidebar.Provider>
          </div>
        </div>
      </Section>
    </Stack>
  )
}

function CodeCard() {
  return (
    <Stack>
      <Section
        title="Code"
        note="Copy-as-code output and rules excerpts. Shiki highlighting, mono at 13 px."
      >
        <Code
          lang="ts"
          code={`const snap = await getDocs(\n  query(collection(db, 'orders'), where('status', '==', 'paid'), orderBy('createdAt', 'desc'), limit(50)),\n)`}
        />
      </Section>
      <Section title="Copyable values">
        <Row label="clipboard">
          <ClipboardText text="http://127.0.0.1:8080" size="base" />
        </Row>
        <Row label="inline">
          <span className="group">
            <InlineCopyText value="u_9f3k2" className="font-mono text-[0.9em]">
              u_9f3k2
            </InlineCopyText>
          </span>
          <span className="group">
            <InlineCopyText value="127.0.0.1:9099" className="font-mono text-[0.9em]">
              127.0.0.1:9099
            </InlineCopyText>
          </span>
        </Row>
      </Section>
    </Stack>
  )
}

defineCards([
  {
    id: 'buttons',
    group: 'Components',
    name: 'Buttons',
    subtitle: 'Six variants, four sizes, icons, loading and disabled',
    width: 880,
    render: () => <Buttons />,
  },
  {
    id: 'badges',
    group: 'Components',
    name: 'Badges',
    subtitle: 'Semantic filled and dot badges, plus the value-type set',
    width: 880,
    render: () => <Badges />,
  },
  {
    id: 'inputs',
    group: 'Components',
    name: 'Inputs',
    subtitle: 'Text, secret, area, select, checkbox, switch, radio',
    width: 880,
    render: () => <Inputs />,
  },
  {
    id: 'tabs-navigation',
    group: 'Components',
    name: 'Tabs and navigation',
    subtitle: 'Segmented and underline tabs, breadcrumbs, links, pagination, toolbar',
    width: 880,
    render: () => <TabsAndNav />,
  },
  {
    id: 'table',
    group: 'Components',
    name: 'Table',
    subtitle: 'Selection, dot status, mono ids that copy, compact header',
    width: 880,
    render: () => <TableCard />,
  },
  {
    id: 'surfaces',
    group: 'Components',
    name: 'Surfaces',
    subtitle: 'Layer card, collapsible, meter, loader',
    width: 880,
    render: () => <Surfaces />,
  },
  {
    id: 'feedback',
    group: 'Components',
    name: 'Feedback',
    subtitle: 'Banners, empty state, toasts',
    width: 880,
    render: () => <Feedback />,
  },
  {
    id: 'overlays',
    group: 'Components',
    name: 'Overlays',
    subtitle: 'Dialog, popover, menu, tooltip, command palette, shown open',
    width: 880,
    render: () => <Overlays />,
  },
  {
    id: 'sidebar',
    group: 'Components',
    name: 'Sidebar',
    subtitle: 'Expanded and collapsed navigation',
    width: 880,
    render: () => <SidebarCard />,
  },
  {
    id: 'code',
    group: 'Components',
    name: 'Code and copy',
    subtitle: 'Highlighted code, clipboard text, inline copy',
    width: 880,
    render: () => <CodeCard />,
  },
])
