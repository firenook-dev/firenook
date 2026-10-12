// Storage's patterns (storage.md §11.3): the Files page as it opens on a
// folder with a picture in the inspector (light and dark), the grid's tiles,
// the inspector's three tabs, the upload tray mid-upload beside the conflict
// question, and the Rules page with a refused upload open and the values
// its rules saw written into the editor.
//
// Every card is the section's own components — the whole Files page, the
// whole Rules page — in front of an engine the card stands in for, so a card
// shows what the console draws and fetches nothing:
//
// - the query cache holds what each page would read, with the engine's own
//   shapes (the rules card's decision was recorded by a real engine);
// - the live channel's leader is the card: it holds the leader lock (so the
//   page is a follower and opens no connection) and answers subscriptions on
//   the tabs' relay, so the decisions panel fills as it does in a browser;
// - pictures a page asks the media and thumbnail routes for are drawn here
//   (an `<img>` cannot take a cached answer), as SVG with their own size;
// - uploads go through the real queue with a transport that holds them
//   mid-way, fails one and finishes another.

import { Button, KumoPortalProvider, Tooltip, TooltipProvider, cn } from '@cloudflare/kumo'
import { CornersOutIcon } from '@phosphor-icons/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { type ReactNode, createContext, use, useEffect, useMemo, useRef, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { IdentityUser } from '@/api/generated/IdentityUser'
import type { Job } from '@/api/generated/Job'
import type { ListMeta } from '@/api/generated/ListMeta'
import type { Page } from '@/api/generated/Page'
import type { RulesVersion } from '@/api/generated/RulesVersion'
import type { StorageActivity } from '@/api/generated/storage/StorageActivity'
import type { StorageBuckets } from '@/api/generated/storage/StorageBuckets'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageDecisionBatch } from '@/api/generated/storage/StorageDecisionBatch'
import type { StorageDecisionDetail } from '@/api/generated/storage/StorageDecisionDetail'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import type { StorageEventPayloads } from '@/api/generated/storage/StorageEventPayloads'
import type { StorageFileEntry } from '@/api/generated/storage/StorageFileEntry'
import type { StorageFolder } from '@/api/generated/storage/StorageFolder'
import type { StorageListPage } from '@/api/generated/storage/StorageListPage'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import type { StorageProfile } from '@/api/generated/storage/StorageProfile'
import type { StorageRulesCheck } from '@/api/generated/storage/StorageRulesCheck'
import type { StorageRulesDocument } from '@/api/generated/storage/StorageRulesDocument'
import type { StorageRulesImpact } from '@/api/generated/storage/StorageRulesImpact'
import type { StorageRulesObjectView } from '@/api/generated/storage/StorageRulesObjectView'
import type { StorageUploadSession } from '@/api/generated/storage/StorageUploadSession'
import { statusQuery } from '@/api/queries'
import { Inspector, InspectorFooter, InspectorTitle } from '@/components/console/inspector'
import type { CursorRows } from '@/components/console/use-cursor-rows'
import { useNow } from '@/lib/clock'
import { formatBytes, relativeTime } from '@/lib/format'
import { identityUsersQuery, parseViewAs } from '@/lib/identity'
import { sectionJobsKey } from '@/lib/jobs'
import { LEADER_LOCK, RELAY_CHANNEL, type RelayMessage } from '@/lib/live/leader'
import { useLayout } from '@/lib/layout'
import type { CoverageReport } from '@/rules/coverage'
import { DEFAULT_SORT, type UploadTransport } from '@/storage/api'
import { ConflictDialog } from '@/storage/components/conflict-dialog'
import { useFileActions } from '@/storage/components/file-actions'
import { FileGrid } from '@/storage/components/file-grid'
import { fileRows } from '@/storage/components/file-list'
import { CodePopover } from '@/storage/components/inspector/code-popover'
import { FileInspector } from '@/storage/components/inspector/file-inspector'
import { MetadataTab } from '@/storage/components/inspector/metadata-tab'
import { StoragePage } from '@/storage/components/storage-page'
import { UploadTray } from '@/storage/components/upload-tray'
import { FilesProvider, type FilesState } from '@/storage/files-state'
import type { Listing } from '@/storage/listing'
import { TEXT_HEAD } from '@/storage/media'
import { changeCount, draftOf, patchOf } from '@/storage/metadata-draft'
import { baseName, foldersOf } from '@/storage/paths'
import {
  ST,
  activityQuery,
  bucketsQuery,
  eventsQuery,
  folderQuery,
  objectQuery,
  objectsList,
  objectsMetaQuery,
  profileQuery,
  rulesScope,
  sessionsQuery,
  storageCoverageQuery,
  storageDecisionQuery,
  storageImpactQuery,
  storageRulesCheckQuery,
  storageRulesHistoryQuery,
  storageRulesQuery,
  treeQuery,
} from '@/storage/queries'
import { storageRulesSearch } from '@/storage/rules-page/rules-search'
import { StorageRulesPage } from '@/storage/rules-page/storage-rules-page'
import { type FilesSearch, filesSearch } from '@/storage/search'
import { useFileSelection } from '@/storage/selection'
import { EMPTY_OPTIONS } from '@/storage/upload-options'
import { type UploadPlan, enqueueUploads, setUploadTransport } from '@/storage/uploads'
import { sectionEntry, testStatus } from '@/test/status'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

// ---- the engine the cards stand in front of ----------------------------

const PROJECT = 'demo-shop'
const BUCKET = 'demo-shop.appspot.com'
const MEDIA = 'demo-shop-media'
const ADA = 'u_k65eq'
const GRACE = 'u_3wc4h'
/** Ada's folder: where the Files cards open. */
const HOME = `users/${ADA}/`
const OWNER = parseViewAs(undefined)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A moment this long before the card is drawn, so relative times read as they would. */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
/** A generation as the protocol writes one: the write's time in microseconds. */
const generationAt = (ms: number) => String((Date.now() - ms) * 1000 + 417)
const noop = () => {}

const STATUS: ConsoleStatus = testStatus({
  projectId: PROJECT,
  engine: { name: 'Firenook', version: '0.2.0', revision: null, consoleBuild: 'design-system' },
  services: (
    [
      ['auth', 9099],
      ['firestore', 8080],
      ['functions', 5001],
      ['hub', 4400],
      ['storage', 9199],
      ['ui', 4000],
    ] as const
  ).map(([name, port]) => ({ name, host: '127.0.0.1', port, listening: true, pid: null })),
  startedAt: ago(3 * HOUR),
  sections: ['firestore', 'auth', 'storage', 'functions'].map((id) => sectionEntry(id)),
})

// ---- pictures: what the media and thumbnail routes would send ----------

/** A photograph's stand-in: sky, sun, two hills, at the size the file has. */
function landscape(
  width: number,
  height: number,
  colors: { sky: [string, string]; sun: string; far: string; near: string },
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 160 107" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colors.sky[0]}"/><stop offset="1" stop-color="${colors.sky[1]}"/></linearGradient></defs><rect width="160" height="107" fill="url(#s)"/><circle cx="112" cy="38" r="12" fill="${colors.sun}"/><path d="M0 74 Q36 50 78 66 T160 58 V107 H0Z" fill="${colors.far}"/><path d="M0 88 Q48 72 98 86 T160 82 V107 H0Z" fill="${colors.near}"/></svg>`
}

/** A profile picture's stand-in: a head and shoulders on a round ground. */
function portrait(size: number, ground: string, figure: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" fill="${ground}"/><circle cx="32" cy="25" r="11" fill="${figure}"/><path d="M10 64 Q12 42 32 42 T54 64Z" fill="${figure}"/></svg>`
}

/** A drawing with a transparent ground, so the checkerboard shows through. */
function sketch(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48"><path d="M8 38 L20 14 L28 28 L34 20 L42 38Z" fill="none" stroke="#e8590c" stroke-width="2.5" stroke-linejoin="round"/><circle cx="35" cy="12" r="4" fill="#f59f00"/></svg>`
}

/** Pictures by object name; the colours are the files' own, not the console's. */
const PICTURES: Record<string, string> = {
  [`${HOME}cover.jpg`]: landscape(1600, 1067, {
    sky: ['#7fb2e5', '#f6d9b8'],
    sun: '#fff4d6',
    far: '#8a9a6b',
    near: '#4f6b3c',
  }),
  [`${HOME}IMG_2041.jpg`]: landscape(4032, 3024, {
    sky: ['#2b3a67', '#f08a5d'],
    sun: '#ffd27f',
    far: '#5b4a6b',
    near: '#2d2438',
  }),
  [`${HOME}avatar.png`]: portrait(512, '#d9e6f2', '#5b7db1'),
  [`${HOME}sketch.svg`]: sketch(480),
}

/** What a picture route answers for `url`: the file's stand-in, drawn as a data URL. */
function pictureFor(url: string): string {
  const name = new URL(url, 'http://card.test').searchParams.get('name') ?? ''
  const svg = PICTURES[name] ?? portrait(256, '#e9ecef', '#adb5bd')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const PICTURE_ROUTES = '/console/api/v1/storage/object/'

/** The picture for an address the page set: the card's stand-in for the engine's routes. */
const swap = (value: string) => (value.startsWith(PICTURE_ROUTES) ? pictureFor(value) : value)

/**
 * The media and thumbnail routes, answered by the card. An image's address
 * reaches the element two ways — React sets the attribute when it creates
 * the image and the property again once it is mounted — so images alone are
 * given both, swapping the engine's address for the picture before it loads.
 */
function drawPicturesHere() {
  const proto = HTMLImageElement.prototype
  const src = Object.getOwnPropertyDescriptor(proto, 'src')
  if (Object.hasOwn(proto, 'setAttribute') || !src?.get || !src.set) return
  const { get, set } = src
  const setAttribute = Element.prototype.setAttribute
  Object.defineProperty(proto, 'setAttribute', {
    configurable: true,
    writable: true,
    value(this: HTMLImageElement, name: string, value: string) {
      setAttribute.call(this, name, name === 'src' ? swap(value) : value)
    },
  })
  Object.defineProperty(proto, 'src', {
    configurable: true,
    enumerable: src.enumerable ?? true,
    get(this: HTMLImageElement) {
      return get.call(this)
    },
    set(this: HTMLImageElement, value: string) {
      set.call(this, swap(value))
    },
  })
}

// ---- the live channel: the card leads it --------------------------------

type Answer = { name: string; data: unknown }

/** What the card's engine sends a new subscription: its replay, as events. */
let answerer: (topic: string, params: Record<string, unknown>) => readonly Answer[] = () => []
let leading = false

/**
 * Holds the leader lock before any view subscribes (lock requests are
 * granted in order), so the page is a follower that opens no connection,
 * and answers the followers on the relay the way a leading tab relays an
 * engine: hello, the channel's state, each subscription accepted with what
 * the engine would replay for it.
 */
function leadTheLiveChannel() {
  if (leading || !navigator.locks || typeof BroadcastChannel === 'undefined') return
  leading = true
  void navigator.locks.request(LEADER_LOCK, () => new Promise<void>(() => undefined))
  const relay = new BroadcastChannel(RELAY_CHANNEL)
  // A BroadcastChannel reaches this origin's own tabs only; it takes no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  const send = (message: RelayMessage) => relay.postMessage(message)
  const answered = new Set<string>()
  relay.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as RelayMessage
    if (message.t === 'who') {
      send({
        t: 'hello',
        leader: 'card',
        instance: 'card-engine',
        consoleBuild: 'design-system',
        engineRevision: null,
      })
      send({ t: 'status', leader: 'card', status: 'live' })
      return
    }
    if (message.t !== 'sub' || answered.has(message.id)) return
    answered.add(message.id)
    send({ t: 'accepted', subs: [message.id] })
    for (const [index, answer] of answerer(message.topic, message.params).entries())
      send({
        t: 'ev',
        kind: 'ev',
        subs: [message.id],
        raw: JSON.stringify({
          sub: message.id,
          name: answer.name,
          cursor: `card.${index + 1}`,
          data: answer.data,
        }),
      })
  })
}

// ---- the providers -------------------------------------------------------

const CardContent = createContext<ReactNode>(null)

function CardRoot() {
  return <>{use(CardContent)}</>
}

/**
 * The console's providers around a card: the query cache filled as given,
 * and a router with the two Storage routes (the Rules page's id keeps the
 * trailing underscore its file route has), opened at `at`.
 */
function Kit({
  at = '/',
  fill,
  children,
}: {
  at?: string
  fill?: (client: QueryClient) => void
  children: ReactNode
}) {
  const [client] = useState(() => {
    leadTheLiveChannel()
    drawPicturesHere()
    answerTheConsoleApi()
    const created = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    created.setQueryData(statusQuery.queryKey, STATUS)
    created.setQueryData(bucketsQuery(PROJECT).queryKey, BUCKETS)
    created.setQueryData(sectionJobsKey('storage'), [] satisfies Job[])
    fill?.(created)
    return created
  })
  const [router] = useState(() => {
    const root = createRootRoute({ component: CardRoot })
    const files = createRoute({
      getParentRoute: () => root,
      path: '/storage',
      validateSearch: filesSearch,
    })
    const rules = createRoute({
      getParentRoute: () => root,
      path: '/storage/rules',
      validateSearch: storageRulesSearch,
    }).update({ id: '/storage_/rules' } as never)
    return createRouter({
      routeTree: root.addChildren([files, rules]),
      history: createMemoryHistory({ initialEntries: [at] }),
    })
  })
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
  height: number
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'relative flex min-w-0 overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line',
        className,
      )}
      style={{ height }}
    >
      {children}
    </div>
  )
}

/** The shell's section panel (`PANEL_WIDTH`), where the folders panel portals as it does in the app. */
function PanelSlot() {
  const setSlot = useLayout((state) => state.setSlot)
  return (
    <aside
      ref={setSlot}
      aria-label="Folders"
      className="flex min-h-0 w-[264px] shrink-0 flex-col border-r border-kumo-line bg-kumo-base"
    />
  )
}

/** The Files page's state for a card that shows one part of it: nothing it does moves. */
function filesState(view: Partial<FilesSearch>): FilesState {
  const search: FilesSearch = { sort: undefined, ...view }
  const viewAs = parseViewAs(search.as)
  return {
    project: PROJECT,
    buckets: BUCKETS,
    bucket: search.bucket ?? BUCKET,
    prefix: search.path ?? '',
    object: search.object,
    tab: search.tab ?? 'details',
    layout: search.layout ?? 'list',
    sort: search.sort ?? DEFAULT_SORT,
    q: search.q ?? '',
    flat: search.flat ?? false,
    viewAs,
    admin: viewAs.kind === 'owner',
    search,
    update: noop,
    goTo: noop,
    setBucket: noop,
    openObject: noop,
    setViewAs: noop,
  }
}

// ---- the bucket ----------------------------------------------------------

function folder(
  prefix: string,
  objects: number,
  bytes: number,
  folders: number,
  changedMs: number,
): StorageEntry {
  return {
    type: 'folder',
    prefix,
    objects,
    bytes,
    folders,
    changedAt: ago(changedMs),
    empty: false,
  }
}

/** A folder only its zero-byte marker holds. */
function marker(prefix: string, changedMs: number): StorageEntry {
  return {
    type: 'folder',
    prefix,
    objects: 0,
    bytes: 0,
    folders: 0,
    changedAt: ago(changedMs),
    empty: true,
  }
}

function file(
  name: string,
  size: number,
  contentType: string,
  updatedMs: number,
  extra: Partial<StorageFileEntry> = {},
): StorageEntry {
  return {
    type: 'file',
    name,
    size,
    contentType,
    contentEncoding: null,
    updated: ago(updatedMs),
    timeCreated: ago(updatedMs + 3 * DAY),
    generation: generationAt(updatedMs),
    tokens: 1,
    metadataKeys: [],
    metadataCount: 0,
    ...extra,
  }
}

const PREFS_TEXT = `{
  "theme": "dark",
  "language": "en-GB",
  "currency": "EUR",
  "notifications": {
    "orders": true,
    "restocks": true,
    "marketing": false
  },
  "recentSearches": ["linen shirt", "espresso cups"]
}
`
const PREFS_BYTES = new TextEncoder().encode(PREFS_TEXT)

/** What is directly in Ada's folder: three folders, then ten files by name. */
const HOME_FOLDERS: StorageEntry[] = [
  marker(`${HOME}drafts/`, 2 * DAY),
  folder(`${HOME}photos/`, 24, 18_402_113, 0, 5 * HOUR),
  folder(`${HOME}receipts/`, 12, 1_923_377, 0, 3 * DAY),
]
const HOME_FILES: StorageEntry[] = [
  file(`${HOME}IMG_2041.jpg`, 3_128_406, 'image/jpeg', 50 * MINUTE),
  file(`${HOME}archive-2025.zip`, 3_481_207, 'application/zip', 9 * DAY),
  file(`${HOME}avatar.png`, 48_211, 'image/png', 2 * HOUR),
  file(`${HOME}cover.jpg`, 1_241_880, 'image/jpeg', 4 * MINUTE, {
    metadataKeys: ['caption', 'ownerUid'],
    metadataCount: 2,
    timeCreated: ago(2 * HOUR),
  }),
  file(`${HOME}invoice-2026-09.pdf`, 186_422, 'application/pdf', 3 * DAY),
  file(`${HOME}notes.md`, 2_148, 'text/markdown', 26 * MINUTE),
  file(`${HOME}orders.csv`, 52_310, 'text/csv', 2 * DAY),
  file(`${HOME}prefs.json`, PREFS_BYTES.length, 'application/json', HOUR),
  file(`${HOME}sketch.svg`, 9_204, 'image/svg+xml', 6 * HOUR),
  file(`${HOME}trip.mp4`, 14_820_117, 'video/mp4', 6 * DAY, { tokens: 2 }),
]
const HOME_ENTRIES = [...HOME_FOLDERS, ...HOME_FILES]

const sizeOf = (entries: readonly StorageEntry[]) =>
  entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : (entry.bytes ?? 0)), 0)
const countOf = (entries: readonly StorageEntry[]) =>
  entries.reduce((sum, entry) => sum + (entry.type === 'file' ? 1 : (entry.objects ?? 0)), 0)

const HOME_BYTES = sizeOf(HOME_ENTRIES)
const HOME_OBJECTS = countOf(HOME_ENTRIES)
const DIRECT_BYTES = sizeOf(HOME_FILES)

/** The other users' folders, so `users/` reads as an app's. */
const USERS: StorageEntry[] = [
  folder(`users/${GRACE}/`, 9, 2_204_118, 1, 40 * MINUTE),
  folder('users/u_7tq2m/', 3, 412_660, 0, 2 * DAY),
  folder(HOME, HOME_OBJECTS, HOME_BYTES, HOME_FOLDERS.length, 4 * MINUTE),
  folder('users/u_pyudw/', 5, 1_870_224, 1, 5 * HOUR),
  folder('users/u_x81ra/', 1, 18_302, 0, 12 * DAY),
]
const ROOT: StorageEntry[] = [
  folder('exports/', 1_201, 21_364_880, 0, 4 * HOUR),
  folder('public/', 8, 2_123_335, 3, 3 * DAY),
  folder('reports/', 1, 547, 0, 6 * DAY),
  folder('shared/', 2, 18_896, 0, 2 * DAY),
  folder('users/', countOf(USERS), sizeOf(USERS), USERS.length, 4 * MINUTE),
]

const BUCKETS: StorageBuckets = {
  defaultBucket: BUCKET,
  rulesMode: 'perBucket',
  indexReady: true,
  buckets: [
    {
      name: BUCKET,
      isDefault: true,
      configured: true,
      served: true,
      rulesFile: '/work/demo-shop/storage.rules',
      objects: countOf(ROOT),
      bytes: sizeOf(ROOT),
      inFlight: { uploads: 0, bytes: 0 },
    },
    {
      name: MEDIA,
      isDefault: false,
      configured: true,
      served: true,
      rulesFile: '/work/demo-shop/storage.media.rules',
      objects: 31,
      bytes: 2_412_002,
      inFlight: { uploads: 0, bytes: 0 },
    },
  ],
}

/** One page of a level, as `GET /storage/objects` answers it. */
function levelPage(prefix: string, items: readonly StorageEntry[]): StorageListPage {
  const files = items.filter((entry) => entry.type === 'file')
  return {
    bucket: BUCKET,
    prefix,
    totals: {
      folders: items.length - files.length,
      files: files.length,
      bytes: sizeOf(files),
      filtered: false,
    },
    placeholder: false,
    revision: 1_290,
    decision: null,
    stale: false,
    changesSince: 0,
    items: [...items],
    nextCursor: null,
    prevCursor: null,
    total: { count: items.length, exact: true },
    scanned: null,
  }
}

const HOME_FIGURES: StorageFolder = {
  bucket: BUCKET,
  prefix: HOME,
  objects: HOME_OBJECTS,
  bytes: HOME_BYTES,
  folders: HOME_FOLDERS.length,
  foldersBelow: HOME_FOLDERS.length,
  directFiles: HOME_FILES.length,
  directBytes: DIRECT_BYTES,
  changedAt: ago(4 * MINUTE),
  placeholder: false,
}

const HOME_PROFILE: StorageProfile = {
  bucket: BUCKET,
  prefix: HOME,
  objects: HOME_OBJECTS,
  bytes: HOME_BYTES,
  maxSize: 14_820_117,
  typicalSize: 3_481_207,
  contentTypes: [
    { contentType: 'image/jpeg', objects: 26, bytes: 22_772_399 },
    { contentType: 'application/pdf', objects: 13, bytes: 2_109_799 },
    { contentType: 'video/mp4', objects: 1, bytes: 14_820_117 },
    { contentType: 'application/zip', objects: 1, bytes: 3_481_207 },
  ],
  metadataKeys: ['ownerUid', 'caption', 'orderId'],
  childFolders: ['drafts', 'photos', 'receipts'],
  sampled: false,
}

/** The filter's fields, as `GET /storage/objects/meta` names them. */
const META: ListMeta = {
  sortable: ['name', 'size', 'updated', 'type'],
  defaultSort: 'name:asc',
  fields: [
    {
      key: 'name',
      aliases: [],
      kind: 'text',
      help: 'Name below the folder',
      values: [],
      valueAliases: {},
      prefixes: [],
    },
    {
      key: 'type',
      aliases: ['contenttype'],
      kind: 'exact',
      help: 'Content type, like type:image/*',
      values: [],
      valueAliases: {},
      prefixes: [],
    },
    {
      key: 'size',
      aliases: [],
      kind: 'bytes',
      help: 'Size, like size:>5MB',
      values: [],
      valueAliases: {},
      prefixes: [],
    },
    {
      key: 'updated',
      aliases: [],
      kind: 'time',
      help: 'Last changed, like updated:>-1h',
      values: [],
      valueAliases: {},
      prefixes: [],
    },
    {
      key: 'created',
      aliases: [],
      kind: 'time',
      help: 'Created, like created:<2026-10-01',
      values: [],
      valueAliases: {},
      prefixes: [],
    },
    {
      key: 'meta',
      aliases: [],
      kind: 'path',
      help: 'Custom metadata, like meta.ownerUid:u_9f3k2',
      values: [],
      valueAliases: {},
      prefixes: ['meta.'],
    },
    {
      key: 'has',
      aliases: [],
      kind: 'enum',
      help: 'Has a field: has:token, -has:type',
      values: ['token', 'type', 'metadata', 'encoding', 'cache'],
      valueAliases: {},
      prefixes: [],
    },
  ],
}

const NO_SESSIONS: Page<StorageUploadSession> = {
  items: [],
  nextCursor: null,
  prevCursor: null,
  total: null,
  scanned: null,
}

/** An object as `GET /storage/object` answers the owner, from its listing entry. */
function detailOf(name: string, extra: Partial<StorageObjectDetail> = {}): StorageObjectDetail {
  const entry = HOME_FILES.find((candidate) => candidate.type === 'file' && candidate.name === name)
  if (entry?.type !== 'file') throw new Error(`no card file ${name}`)
  return {
    bucket: BUCKET,
    name,
    size: entry.size,
    contentType: entry.contentType,
    cacheControl: null,
    contentDisposition: 'inline',
    contentEncoding: null,
    contentLanguage: null,
    customMetadata: {},
    downloadTokens: ['3f8a2c71-9b4e-4d0a-8c55-61e2f07b9d14'],
    tokensVisible: true,
    md5Hash: 'k2Q0bF6m3yR9xTqWv8sLdA==',
    crc32c: 'p4VgXw==',
    etag: 'MTc5MTgwOTU1NzEyNTc0ODoz',
    generation: entry.generation,
    metageneration: '1',
    storageClass: 'STANDARD',
    timeCreated: entry.timeCreated,
    updated: entry.updated,
    sniffed: null,
    placeholder: false,
    decision: null,
    ...extra,
  }
}

const COVER = detailOf(`${HOME}cover.jpg`, {
  cacheControl: 'public, max-age=3600',
  customMetadata: { caption: 'Lisbon, from the castle walls', ownerUid: ADA },
  metageneration: '3',
  sniffed: { mime: 'image/jpeg', family: 'image', definite: true },
})
const PREFS = detailOf(`${HOME}prefs.json`, {
  cacheControl: 'private, max-age=0',
  contentDisposition: null,
  downloadTokens: ['b71e0d4a-2c9f-4e53-9a6d-0f3e8c1b7a25'],
  md5Hash: 'Xb1m9QwZp0eT7cVr4kLyHg==',
  crc32c: 'Gm2s8A==',
  etag: 'MTc5MTgwNjQ1ODEyNTc0ODox',
  sniffed: { mime: 'application/json', family: 'text', definite: false },
})

/** The event bodies an object sends, shaped as the engine builds them. */
function eventBodies(object: StorageObjectDetail): StorageEventPayloads {
  const path = encodeURIComponent(object.name)
  const data = {
    bucket: object.bucket,
    contentDisposition: object.contentDisposition,
    contentType: object.contentType,
    crc32c: object.crc32c,
    etag: object.etag,
    generation: object.generation,
    id: `${object.bucket}/${object.name}/${object.generation}`,
    kind: 'storage#object',
    md5Hash: object.md5Hash,
    mediaLink: `http://127.0.0.1:9199/download/storage/v1/b/${object.bucket}/o/${path}?generation=${object.generation}&alt=media`,
    metadata: {
      ...object.customMetadata,
      firebaseStorageDownloadTokens: object.downloadTokens.join(','),
    },
    metageneration: object.metageneration,
    name: object.name,
    selfLink: `http://127.0.0.1:9199/storage/v1/b/${object.bucket}/o/${path}`,
    size: String(object.size),
    storageClass: object.storageClass,
    timeCreated: object.timeCreated,
    timeStorageClassUpdated: object.timeCreated,
    updated: object.updated,
  }
  const body = (event: string, v1: string, v2: string, id: string) => ({
    v1: {
      data,
      eventId: id,
      eventType: `google.storage.object.${v1}`,
      resource: {
        name: `projects/_/buckets/${object.bucket}/objects/${object.name}`,
        service: 'storage.googleapis.com',
        type: 'storage#object',
      },
      timestamp: object.updated,
    },
    v2: {
      data,
      id: `${id}-${event}`,
      source: `//storage.googleapis.com/projects/_/buckets/${object.bucket}/objects/${object.name}`,
      specversion: '1.0',
      time: object.updated,
      type: `google.cloud.storage.object.v1.${v2}`,
    },
  })
  return {
    functions: true,
    finalize: body('finalize', 'finalize', 'finalized', '3250787777441'),
    metadataUpdate: body('metadata', 'metadataUpdate', 'metadataUpdated', '6026444453589'),
    delete: body('delete', 'delete', 'deleted', '1840227369052'),
  }
}

// ---- what the rules decided ---------------------------------------------

/** The default bucket's rules: each user's folder is theirs (images under 5 MB), `public/` is open. */
const RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null && request.auth.uid == uid
        && request.resource.size < 5 * 1024 * 1024
        && request.resource.contentType.matches('image/.*');
    }
    match /public/{allPaths=**} {
      allow read;
    }
    match /reports/{report} {
      allow read: if firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.plan == 'pro';
    }
    match /shared/{allPaths=**} {
      allow list: if request.auth != null;
      allow get: if request.auth != null && resource.metadata.ownerUid == request.auth.uid;
    }
  }
}
`
/** The engine's hash of `RULES`. */
const RULES_HASH = '2A4RSl11B68orw-vkXOEbc-J9niLFr6sGArfeHEv6uw'
const READ_ALLOW = { line: 5, from: 132, to: 179 }
const WRITE_ALLOW = { line: 6, from: 203, to: 361 }

function decision(
  id: string,
  atMs: number,
  fields: Pick<StorageDecision, 'method' | 'path' | 'outcome' | 'uid'> &
    Partial<StorageDecision> & { allow: { line: number; from: number; to: number } },
): StorageDecision {
  const { allow, ...rest } = fields
  return {
    id,
    at: ago(atMs),
    bucket: BUCKET,
    error: null,
    tenant: null,
    provider: fields.uid === null ? null : 'password',
    anonymous: fields.uid === null,
    allows: [{ ...allow, outcome: fields.outcome }],
    rulesHash: RULES_HASH,
    noRuleset: false,
    size: null,
    contentType: null,
    viaConsole: false,
    ...rest,
  }
}

/** Oldest first, as a batch carries them. */
const DECISIONS: StorageDecision[] = [
  decision('s1', 38 * MINUTE, {
    method: 'create',
    path: `${HOME}cover.jpg`,
    outcome: 'allow',
    uid: ADA,
    allow: WRITE_ALLOW,
    size: 1_241_880,
    contentType: 'image/jpeg',
  }),
  decision('s2', 21 * MINUTE, {
    method: 'list',
    path: HOME,
    outcome: 'allow',
    uid: ADA,
    allow: READ_ALLOW,
  }),
  decision('s3', 14 * MINUTE, {
    method: 'get',
    path: 'public/logo.png',
    outcome: 'allow',
    uid: null,
    allow: { line: 11, from: 419, to: 419 },
  }),
  decision('s4', 12 * MINUTE, {
    method: 'get',
    path: `${HOME}cover.jpg`,
    outcome: 'deny',
    uid: GRACE,
    allow: READ_ALLOW,
  }),
  decision('s5', 6 * MINUTE, {
    method: 'create',
    path: `${HOME}avatar.png`,
    outcome: 'allow',
    uid: ADA,
    allow: WRITE_ALLOW,
    size: 48_211,
    contentType: 'image/png',
  }),
  decision('s6', 3 * MINUTE, {
    method: 'list',
    path: HOME,
    outcome: 'deny',
    uid: GRACE,
    allow: READ_ALLOW,
  }),
  decision('s7', MINUTE, {
    method: 'create',
    path: `${HOME}notes.txt`,
    outcome: 'deny',
    uid: ADA,
    allow: WRITE_ALLOW,
    size: 12,
    contentType: 'text/plain',
  }),
]

const REFUSED = 's7'
const NOW_SECONDS = Math.floor(Date.now() / 1000)
const ADA_CLAIMS = {
  aud: PROJECT,
  auth_time: NOW_SECONDS - 67,
  email: 'ada@example.test',
  email_verified: false,
  exp: NOW_SECONDS + 3_540,
  firebase: { identities: { email: ['ada@example.test'] }, sign_in_provider: 'password' },
  iat: NOW_SECONDS - 60,
  iss: `https://securetoken.google.com/${PROJECT}`,
  name: 'Ada Lovelace',
  sub: ADA,
  user_id: ADA,
}
const NOTES: StorageRulesObjectView = {
  name: `${HOME}notes.txt`,
  bucket: BUCKET,
  size: 12,
  contentType: 'text/plain',
  contentDisposition: null,
  contentEncoding: null,
  metadata: {},
  generation: generationAt(MINUTE),
  metageneration: '1',
  timeCreated: ago(MINUTE),
  updated: ago(MINUTE),
  md5Hash: 'ZOcbs/uNBkevLH03Jphpag==',
  crc32c: '3785077363',
  etag: 'MTc5MTgwOTM1ODAzODc1MDox',
}
const REQUEST = `request(create /b/${BUCKET}/o/${HOME}notes.txt)`
const AUTH = '{uid: "u_k65eq", token: {…}}'
const PROPOSED =
  '{bucket: "demo-shop.appspot.com", contentDisposition: null, contentEncoding: null, contentType: "text/plain", crc32c: "3785077363", etag: "MTc5MTgwOTM1ODAzODc1…'

/** The refused upload run again: what each expression of line 6 had (a real engine's answer). */
const REFUSED_DETAIL: StorageDecisionDetail = {
  id: REFUSED,
  recordedOutcome: 'deny',
  rules: RULES,
  rulesHash: RULES_HASH,
  claims: ADA_CLAIMS,
  request: {
    method: 'create',
    bucket: BUCKET,
    path: `${HOME}notes.txt`,
    auth: { uid: ADA, token: ADA_CLAIMS },
    proposed: {
      size: 12,
      contentType: 'text/plain',
      contentDisposition: null,
      contentEncoding: null,
      customMetadata: {},
    },
    requestResource: NOTES,
    resource: null,
    time: ago(MINUTE),
  },
  result: {
    outcome: 'deny',
    error: null,
    allows: [{ ...WRITE_ALLOW, outcome: 'deny' }],
    explanation: (
      [
        [203, 210, 6, REQUEST],
        [203, 215, 6, AUTH],
        [203, 223, 6, 'true'],
        [227, 234, 6, REQUEST],
        [227, 239, 6, AUTH],
        [227, 243, 6, '"u_k65eq"'],
        [247, 250, 6, '"u_k65eq"'],
        [227, 250, 6, 'true'],
        [203, 250, 6, 'true'],
        [262, 269, 7, REQUEST],
        [262, 278, 7, PROPOSED],
        [262, 283, 7, '12'],
        [286, 294, 7, '5120'],
        [286, 301, 7, '5242880'],
        [262, 301, 7, 'true'],
        [203, 301, 6, 'true'],
        [313, 320, 8, REQUEST],
        [313, 329, 8, PROPOSED],
        [313, 341, 8, '"text/plain"'],
        [313, 361, 8, 'false'],
        [203, 361, 6, 'false'],
      ] as const
    ).map(([from, to, line, value]) => ({ from, to, line, value, error: false })),
    truncated: false,
    documentAccesses: 0,
    documentAccessLimit: 10,
    resource: null,
    requestResource: NOTES,
    changedKeys: null,
  },
}

const RULES_DOCUMENT: StorageRulesDocument = {
  bucket: BUCKET,
  mode: 'perBucket',
  source: RULES,
  enforced: true,
  hash: RULES_HASH,
  origin: 'startup',
  path: '/work/demo-shop/storage.rules',
  fileSource: RULES,
  fileProblems: [],
  governs: [BUCKET],
  openDefault: false,
  claimReads: [],
}

/** The check of the rules in force: two warnings the Folders tab counts. */
const RULES_CHECK: StorageRulesCheck = {
  diagnostics: [
    {
      severity: 'warning',
      message: 'Anyone, signed in or not, can read every file under /public/{allPaths=**}',
      line: 11,
      column: 7,
      from: 409,
      to: 420,
      code: 'open-access',
    },
    {
      severity: 'warning',
      message:
        'Any signed-in user can list every file here, not only their own. Compare request.auth.uid with the {uid} in the path.',
      line: 17,
      column: 22,
      from: 631,
      to: 651,
      code: 'auth-only',
    },
  ],
  outline: {
    rulesVersion: 2,
    matches: [
      {
        path: '/users/{uid}/{allPaths=**}',
        line: 4,
        from: 76,
        to: 108,
        depth: 0,
        allows: [
          {
            line: 5,
            from: 117,
            to: 180,
            operations: ['get', 'list'],
            condition: 'request.auth != null && request.auth.uid == uid',
            always: null,
          },
          {
            line: 6,
            from: 187,
            to: 362,
            operations: ['create', 'update', 'delete'],
            condition:
              "request.auth != null && request.auth.uid == uid\n        && request.resource.size < 5 * 1024 * 1024\n        && request.resource.contentType.matches('image/.*')",
            always: null,
          },
        ],
      },
      {
        path: '/public/{allPaths=**}',
        line: 10,
        from: 373,
        to: 400,
        depth: 0,
        allows: [
          {
            line: 11,
            from: 409,
            to: 420,
            operations: ['get', 'list'],
            condition: 'true',
            always: true,
          },
        ],
      },
      {
        path: '/reports/{report}',
        line: 13,
        from: 431,
        to: 454,
        depth: 0,
        allows: [
          {
            line: 14,
            from: 463,
            to: 569,
            operations: ['get', 'list'],
            condition:
              "firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.plan == 'pro'",
            always: null,
          },
        ],
      },
      {
        path: '/shared/{allPaths=**}',
        line: 16,
        from: 580,
        to: 607,
        depth: 0,
        allows: [
          {
            line: 17,
            from: 616,
            to: 652,
            operations: ['list'],
            condition: 'request.auth != null',
            always: null,
          },
          {
            line: 18,
            from: 659,
            to: 744,
            operations: ['get'],
            condition: 'request.auth != null && resource.metadata.ownerUid == request.auth.uid',
            always: null,
          },
        ],
      },
    ],
  },
  map: null,
  claimReads: [],
}

const HISTORY: RulesVersion[] = [
  { hash: RULES_HASH, source: RULES, origin: 'startup', installedAt: STATUS.startedAt },
]

/** A condition of the report: where it is, what it came to and how often (`[true, false]` counts). */
function condition(
  line: number,
  column: number,
  from: number,
  to: number,
  counts: readonly [number, number],
  children: CoverageReport['report'] = [],
): NonNullable<CoverageReport['report']>[number] {
  const values = [
    { value: { boolValue: true }, count: counts[0] },
    { value: { boolValue: false }, count: counts[1] },
  ].filter((item) => item.count > 0)
  return {
    sourcePosition: { line, column, currentOffset: from, endOffset: to },
    ...(values.length > 0 ? { values } : {}),
    children,
  }
}

/**
 * How often each condition ran for `DECISIONS`, in the official report's
 * shape (top-level conditions and their first parts): the read on line 5
 * true once and false twice, the write on line 6 true twice and false once
 * (the text file), and the three conditions nothing reached.
 */
const COVERAGE: CoverageReport = {
  rules: { files: [{ name: 'storage.rules', content: RULES }] },
  report: [
    condition(
      5,
      22,
      132,
      178,
      [1, 2],
      [condition(5, 22, 132, 151, [3, 0]), condition(5, 46, 156, 178, [1, 2])],
    ),
    condition(
      6,
      23,
      203,
      359,
      [2, 1],
      [condition(6, 23, 203, 300, [3, 0]), condition(8, 12, 313, 359, [2, 1])],
    ),
    condition(14, 22, 478, 567, [0, 0]),
    condition(17, 22, 631, 650, [0, 0]),
    condition(18, 21, 673, 742, [0, 0]),
  ],
}

/** What the card answers for the console API reads a page makes again by itself. */
const ROUTES: Record<string, () => unknown> = {
  '/console/api/v1/storage/rules/coverage': () => COVERAGE,
}

/**
 * The console API, answered by the card for the reads a page repeats on
 * its own (coverage is read again as decisions arrive). Every other read is
 * in the query cache already; one that is not is a gap in the card, thrown
 * so the capture fails.
 */
function answerTheConsoleApi() {
  if (window.fetch.name === 'cardFetch') return
  const network = window.fetch.bind(window)
  window.fetch = function cardFetch(input: RequestInfo | URL, init?: RequestInit) {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href, window.location.href)
    if (!url.pathname.startsWith('/console/api/')) return network(input, init)
    const answer = ROUTES[url.pathname]
    if (answer) return Promise.resolve(Response.json(answer()))
    // Thrown where nothing catches it: the capture reports page errors.
    queueMicrotask(() => {
      throw new Error(`The storage card has no answer for ${url.pathname}`)
    })
    return Promise.resolve(
      Response.json(
        { error: { code: 'unavailable', message: 'The design system has no engine.' } },
        { status: 503 },
      ),
    )
  }
}

/** What the card's engine replays to a subscription: Storage's decisions, narrowed as asked. */
function replay(topic: string, params: Record<string, unknown>): readonly Answer[] {
  if (topic !== 'storage.decisions') return []
  const path = typeof params['path'] === 'string' ? params['path'] : undefined
  const items = DECISIONS.filter(
    (item) =>
      (params['bucket'] === undefined || item.bucket === params['bucket']) &&
      (path === undefined ||
        (path.endsWith('/') ? item.path.startsWith(path) : item.path === path)) &&
      (params['uid'] === undefined || item.uid === params['uid']) &&
      (params['denied'] !== true || item.outcome !== 'allow') &&
      (params['method'] === undefined || item.method === params['method']),
  )
  const batch: StorageDecisionBatch = {
    items,
    window: {
      retained: DECISIONS.length,
      since: DECISIONS[0]?.at ?? null,
      reRunnable: DECISIONS.length,
      omitted: 0,
    },
  }
  return [{ name: 'decisions', data: batch }]
}
answerer = replay

// ---- the Files page ------------------------------------------------------

/** Everything the Files page reads for Ada's folder with a file open. */
function fillFiles(client: QueryClient) {
  const scope = { bucket: BUCKET, prefix: HOME, flat: false, sort: DEFAULT_SORT }
  client.setQueryData(objectsList(PROJECT, scope, OWNER).queryKey, {
    pages: [levelPage(HOME, HOME_ENTRIES)],
    pageParams: [{}],
  })
  const levels: Record<string, readonly StorageEntry[]> = {
    '': ROOT,
    'users/': USERS,
    [HOME]: HOME_FOLDERS,
  }
  for (const prefix of foldersOf(HOME))
    client.setQueryData(
      treeQuery(PROJECT, BUCKET, prefix).queryKey,
      levelPage(prefix, levels[prefix] ?? []),
    )
  client.setQueryData(folderQuery(PROJECT, BUCKET, HOME).queryKey, HOME_FIGURES)
  client.setQueryData(profileQuery(PROJECT, BUCKET, HOME).queryKey, HOME_PROFILE)
  client.setQueryData(objectsMetaQuery(PROJECT).queryKey, META)
  client.setQueryData(sessionsQuery(PROJECT, BUCKET).queryKey, NO_SESSIONS)
  for (const object of [COVER, PREFS]) {
    client.setQueryData(objectQuery(PROJECT, BUCKET, object.name, OWNER).queryKey, object)
    client.setQueryData(
      eventsQuery(PROJECT, BUCKET, object.name, object.generation).queryKey,
      eventBodies(object),
    )
  }
  client.setQueryData([ST, PROJECT, BUCKET, 'text', PREFS.name, PREFS.generation, TEXT_HEAD], {
    bytes: PREFS_BYTES,
    complete: true,
  })
  client.setQueryData(activityQuery(PROJECT, BUCKET, COVER.name).queryKey, COVER_ACTIVITY)
}

/** cover.jpg's story: made from the app, replaced, its caption set from the console; Grace refused. */
const COVER_ACTIVITY: StorageActivity = {
  changes: [
    {
      revision: 1_290,
      at: ago(4 * MINUTE),
      bucket: BUCKET,
      name: COVER.name,
      kind: 'metadata',
      size: COVER.size,
      contentType: COVER.contentType,
      metadataKeys: ['caption'],
      actor: { kind: 'admin', uid: null, tenant: null, viaConsole: true },
      delivery: 'sent',
    },
    {
      revision: 1_271,
      at: ago(38 * MINUTE),
      bucket: BUCKET,
      name: COVER.name,
      kind: 'replaced',
      size: COVER.size,
      contentType: COVER.contentType,
      metadataKeys: [],
      actor: { kind: 'user', uid: ADA, tenant: null, viaConsole: false },
      delivery: 'sent',
    },
    {
      revision: 412,
      at: COVER.timeCreated,
      bucket: BUCKET,
      name: COVER.name,
      kind: 'created',
      size: 1_180_224,
      contentType: COVER.contentType,
      metadataKeys: [],
      actor: { kind: 'user', uid: ADA, tenant: null, viaConsole: false },
      delivery: 'sent',
    },
  ],
  decisions: DECISIONS.filter((item) => item.path === COVER.name).toReversed(),
  diagnostics: true,
  changesSince: STATUS.startedAt,
  decisionsSince: DECISIONS[0]?.at ?? null,
}

function FilesPage() {
  return (
    <Frame height={760}>
      <PanelSlot />
      <div className="flex min-w-0 flex-1 flex-col">
        <StoragePage />
      </div>
    </Frame>
  )
}

const FILES_AT = `/storage?${new URLSearchParams({ path: HOME, object: COVER.name })}`

function BrowserCard() {
  return (
    <Kit at={FILES_AT} fill={fillFiles}>
      <Stack>
        <Section
          title="Files"
          note="The bucket as a tree in the panel, every figure the folder index's; row one is where you are and who you act as, row two the filter, the count and the order. Folders come first with what is under them; a file opens in the inspector beside the list — its picture, its facts, the URLs an app gets and its download tokens."
        >
          <FilesPage />
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- the grid ------------------------------------------------------------

/** A listing that holds still: the page given, or still loading. */
function stillListing(page: StorageListPage | undefined): Listing {
  const rows: CursorRows<StorageEntry> = {
    rows: page?.items ?? [],
    rowOffset: 0,
    hasMore: false,
    hasPrevious: false,
    loadMore: noop,
    loadPrevious: noop,
    total: page?.total ?? undefined,
    scanned: undefined,
    applyKeys: noop,
    reset: noop,
    flashes: new Map(),
  }
  return {
    scope: { bucket: BUCKET, prefix: HOME },
    rows,
    page,
    pages: page ? [page] : [],
    pending: page === undefined,
    error: null,
    fast: true,
    stale: 0,
    refresh: noop,
    apply: noop,
    retry: noop,
  }
}

const TICKED = [`${HOME}IMG_2041.jpg`, `${HOME}trip.mp4`]

/** The tiles' menus are the page's; a card opens none. */
const menu = () => []

function GridCard() {
  const [files] = useState(() => {
    useFileSelection.getState().set(new Set(TICKED), false)
    return filesState({ path: HOME, object: COVER.name, layout: 'grid' })
  })
  const listing = useMemo(() => stillListing(levelPage(HOME, HOME_ENTRIES)), [])
  const loading = useMemo(() => stillListing(undefined), [])
  const rows = fileRows(listing.rows.rows, {
    prefix: HOME,
    flat: false,
    access: undefined,
    lineText: () => undefined,
  })
  return (
    <Kit fill={fillFiles}>
      <FilesProvider value={files}>
        <Stack>
          <Section
            title="Grid"
            note="Tiles of at least 176 px, as many as fit, virtualized by rows. Pictures come from the engine's thumbnails (SVG and small images as they are), queued three at a time in view order; anything else is its type's icon and extension. A ticked tile keeps its box and brand ring; the cursor tile — here the open file — has the inset ring and its menu."
          >
            <Frame height={940} className="flex-col">
              <FileGrid
                listing={listing}
                rows={rows}
                menu={menu}
                onOpen={noop}
                onCursor={noop}
                empty={null}
              />
            </Frame>
          </Section>
          <Section
            title="While the first page loads"
            note="Two rows of quiet tiles after 150 ms, never a spinner; the grid never draws a tile it has no row for."
          >
            <Frame height={400} className="flex-col">
              <FileGrid
                listing={loading}
                rows={[]}
                menu={menu}
                onOpen={noop}
                onCursor={noop}
                empty={null}
              />
            </Frame>
          </Section>
        </Stack>
      </FilesProvider>
    </Kit>
  )
}

// ---- the inspector -------------------------------------------------------

/** The inspector as the page opens it, on one file and one tab, with the page's own foot. */
function OpenFile({ name, tab }: { name: string; tab: FilesState['tab'] }) {
  const [files] = useState(() => filesState({ path: HOME, object: name, tab }))
  return (
    <FilesProvider value={files}>
      <OpenFileBody name={name} />
    </FilesProvider>
  )
}

function OpenFileBody({ name }: { name: string }) {
  const actions = useFileActions({ prefix: HOME, flat: false, q: undefined })
  return (
    <>
      <FileInspector
        name={name}
        onPrev={noop}
        onNext={noop}
        onQuickLook={noop}
        tools={actions.inspectorTools}
        danger={actions.inspectorDanger}
      />
      {actions.element}
    </>
  )
}

/**
 * The Metadata tab with one field edited and not yet saved. The inspector
 * keeps its draft to itself, so this pane puts the same parts together
 * around a draft that starts edited: the tab, the unsaved mark, Revert and
 * the counted Save.
 */
function EditedMetadata() {
  const [files] = useState(() => filesState({ path: HOME, object: COVER.name, tab: 'metadata' }))
  const base = useMemo(() => draftOf(COVER), [])
  const [draft, setDraft] = useState(() => ({
    ...base,
    fields: { ...base.fields, cacheControl: 'public, max-age=86400, immutable' },
  }))
  const changes = changeCount(patchOf(base, draft))
  const now = useNow('minute')
  return (
    <FilesProvider value={files}>
      <Inspector
        widthKey="storage.object"
        title={<InspectorTitle value={COVER.name}>{baseName(COVER.name)}</InspectorTitle>}
        meta={
          <>
            <span className="font-mono">{formatBytes(COVER.size)}</span>
            <span>·</span>
            <span>{relativeTime(COVER.updated, now)}</span>
          </>
        }
        actions={
          <Tooltip
            content="Quick Look (Shift+Space)"
            render={
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<CornersOutIcon />}
                aria-label="Quick Look"
              />
            }
          />
        }
        onClose={noop}
        closeLabel="Close the file"
        tabs={{
          items: [
            { value: 'details', label: 'Details' },
            {
              value: 'metadata',
              label: 'Metadata',
              count: Object.keys(COVER.customMetadata).length,
            },
            { value: 'activity', label: 'Activity' },
          ],
          value: 'metadata',
          onChange: noop,
        }}
        onPrev={noop}
        onNext={noop}
        noun="file"
        footer={
          <InspectorFooter
            tools={<CodePopover object={COVER} defaultBucket={BUCKET} />}
            primary={
              <>
                {changes > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setDraft(base)}>
                    Revert
                  </Button>
                )}
                <Button
                  variant={changes > 0 ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={changes === 0}
                >
                  {changes > 0 ? `Save ${changes}` : 'Save'}
                </Button>
              </>
            }
          />
        }
        testId="file-inspector"
      >
        <MetadataTab
          object={COVER}
          base={base}
          draft={draft}
          onChange={setDraft}
          keySuggestions={HOME_PROFILE.metadataKeys}
        />
      </Inspector>
    </FilesProvider>
  )
}

function InspectorCard() {
  return (
    <Kit fill={fillFiles}>
      <Stack>
        <Section
          title="Details"
          note="A JSON file's first 256 KB, highlighted, as text or a tree; small UTF-8 files edit in place. Below it the facts the engine keeps, where the file lives — gs://, the path an SDK takes, the download URL an app connected to this emulator gets — and its tokens."
        >
          <Frame height={760}>
            <OpenFile name={PREFS.name} tab="details" />
          </Frame>
        </Section>
        <Section
          title="Metadata, one field edited"
          note="One draft of the standard fields and the custom keys; an edited field carries the brand dot until it is saved, and Save counts what the patch changes."
        >
          <Frame height={480}>
            <EditedMetadata />
          </Frame>
        </Section>
        <Section
          title="Activity"
          note="Changes and the rules' decisions on this name, newest first: who (an Auth user links to Authentication), from the app or the console, and whether the event reached the Functions emulator. Below, the exact bodies the file's events carry."
        >
          <Frame height={720}>
            <OpenFile name={COVER.name} tab="activity" />
          </Frame>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- uploads -------------------------------------------------------------

/** How the card's engine treats each upload: holds it at a share, fails it, or takes it. */
const UPLOADS: Array<{
  name: string
  size: number
  type: string
  outcome: number | 'fail' | 'done'
}> = [
  { name: 'cover-2026.jpg', size: 2_481_002, type: 'image/jpeg', outcome: 0.64 },
  { name: 'lookbook.pdf', size: 9_614_337, type: 'application/pdf', outcome: 0.21 },
  { name: 'price-list.csv', size: 41_288, type: 'text/csv', outcome: 'done' },
  { name: 'banner.png', size: 820_114, type: 'image/png', outcome: 'fail' },
  { name: 'team-offsite.mov', size: 48_200_431, type: 'video/quicktime', outcome: 0.03 },
  { name: 'hero.webp', size: 312_870, type: 'image/webp', outcome: 0 },
]

/** An XHR stand-in that answers the way `UPLOADS` says for the file it sends. */
function cardTransport(): UploadTransport {
  const listeners = new Map<string, Array<() => void>>()
  const progress: Array<
    (event: { loaded: number; total: number; lengthComputable: boolean }) => void
  > = []
  let url = ''
  const transport = {
    status: 0,
    statusText: '',
    responseText: '',
    open: (_method: string, target: string) => {
      url = target
    },
    setRequestHeader: noop,
    upload: {
      addEventListener: (_type: 'progress', listener: (typeof progress)[number]) =>
        void progress.push(listener),
    },
    addEventListener: (type: 'load' | 'error' | 'abort', listener: () => void) =>
      void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    abort: () => listeners.get('abort')?.forEach((listener) => listener()),
    send: () => {
      const name = new URL(url, 'http://card.test').searchParams.get('name') ?? ''
      const upload = UPLOADS.find((candidate) => name.endsWith(candidate.name))
      if (!upload) return
      setTimeout(() => {
        if (upload.outcome === 'fail') {
          listeners.get('error')?.forEach((listener) => listener())
          return
        }
        if (upload.outcome === 'done') {
          transport.status = 200
          transport.responseText = '{}'
          listeners.get('load')?.forEach((listener) => listener())
          return
        }
        const loaded = Math.round(upload.size * upload.outcome)
        for (const listener of progress)
          listener({ loaded, total: upload.size, lengthComputable: true })
      }, 0)
    },
  }
  return transport
}

/** Starts the card's drop once: six files into Ada's folder, one more skipped as taken. */
let dropped = false
function dropFiles() {
  if (dropped) return
  dropped = true
  setUploadTransport(cardTransport)
  const plan = (upload: (typeof UPLOADS)[number]): UploadPlan => ({
    file: new Blob([]),
    name: `${HOME}${upload.name}`,
    size: upload.size,
    contentType: upload.type,
    metadata: {},
  })
  const taken = plan({ name: 'logo.svg', size: 6_210, type: 'image/svg+xml', outcome: 'done' })
  void enqueueUploads(UPLOADS.map(plan), { bucket: BUCKET, project: PROJECT, viewAs: OWNER }, [
    taken,
  ])
}

const CONFLICT = {
  total: 214,
  conflicts: [
    `${HOME}photos/IMG_1988.jpg`,
    `${HOME}photos/IMG_1989.jpg`,
    `${HOME}photos/IMG_1990.jpg`,
    ...Array.from({ length: 9 }, (_, index) => `${HOME}photos/IMG_20${10 + index}.jpg`),
  ],
  folder: `${HOME}photos/`,
  options: EMPTY_OPTIONS,
  withOptions: false,
}

/**
 * A box the page's overlays open into: positioned, and a containing block
 * for `fixed`. A dialog opened by a drop takes focus without a ring; one
 * opened with no pointer before it shows the keyboard's ring on its first
 * control, so the card lets that focus go once the dialog is up.
 */
function OverlayFrame({ height, children }: { height: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const focused = document.activeElement
      if (focused instanceof HTMLElement && box.current?.contains(focused)) focused.blur()
    }, 100)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <div
      ref={box}
      className="relative overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line [transform:translateZ(0)]"
      style={{ height }}
    >
      <KumoPortalProvider container={box}>{children}</KumoPortalProvider>
    </div>
  )
}

function UploadsCard() {
  useState(dropFiles)
  return (
    <Kit fill={fillFiles}>
      <Stack>
        <Section
          title="Upload tray"
          note="Bottom right of the content, the tab's uploads: the whole queue's progress, each file's — three at a time, the rest queued — a failure with Retry, a name skipped as taken, and Cancel all. It stays when you move around the console and folds away a few seconds after everything went through."
        >
          <Frame height={430}>
            <UploadTray />
          </Frame>
        </Section>
        <Section
          title="When names are taken"
          note="One question for the whole drop: replace, skip or keep both, with the drop's options a click away and, while Functions runs, the reminder that uploads fire its triggers. Replace turns the button red and counts."
        >
          <OverlayFrame height={460}>
            <ConflictDialog step={CONFLICT} functions onCancel={noop} onConfirm={noop} />
          </OverlayFrame>
        </Section>
      </Stack>
    </Kit>
  )
}

// ---- the Rules page ------------------------------------------------------

function fillRules(client: QueryClient) {
  const scope = rulesScope(BUCKETS, BUCKET)
  client.setQueryData(storageRulesQuery(PROJECT, scope).queryKey, RULES_DOCUMENT)
  client.setQueryData(storageRulesCheckQuery(PROJECT, scope, RULES).queryKey, RULES_CHECK)
  client.setQueryData(storageRulesHistoryQuery(PROJECT, scope).queryKey, HISTORY)
  client.setQueryData(storageCoverageQuery(PROJECT, scope).queryKey, COVERAGE)
  client.setQueryData(storageImpactQuery(PROJECT, scope, RULES).queryKey, {
    considered: DECISIONS.length,
    flips: [],
  } satisfies StorageRulesImpact)
  client.setQueryData(storageDecisionQuery(PROJECT, scope, REFUSED).queryKey, REFUSED_DETAIL)
  client.setQueryData(identityUsersQuery(PROJECT, '').queryKey, [] satisfies IdentityUser[])
}

const RULES_AT = `/storage/rules?${new URLSearchParams({ decision: REFUSED })}`

function RulesCard() {
  return (
    <Kit at={RULES_AT} fill={fillRules}>
      <Stack>
        <Section
          title="Storage rules"
          note="The editor knows Storage's rules: the file an upload proposes, firestore.get(), the metadata keys the bucket's files carry. Every request the rules judged is listed beside it, newest first; one open lights the lines that decided it and writes after each expression the value it had — here an upload of a text file to a folder that takes only images."
        >
          <Frame height={760} className="flex-col">
            <StorageRulesPage />
          </Frame>
        </Section>
      </Stack>
    </Kit>
  )
}

defineCards([
  {
    id: 'storage-browser',
    group: 'Patterns',
    name: 'Storage files',
    subtitle:
      'The Files page on a folder: the bucket tree in the panel, both toolbar rows, folders first with their figures, an image open in the inspector with its facts, URLs and token',
    width: 1440,
    surface: 'canvas',
    render: () => <BrowserCard />,
  },
  {
    id: 'storage-browser-dark',
    group: 'Patterns',
    name: 'Storage files, dark',
    subtitle: 'The same in dark mode',
    width: 1440,
    dark: true,
    surface: 'canvas',
    render: () => <BrowserCard />,
  },
  {
    id: 'storage-grid',
    group: 'Patterns',
    name: 'Storage grid',
    subtitle:
      'Tiles for pictures, a video, JSON and folders, two ticked, the cursor on the open file, and the loading tiles',
    width: 960,
    surface: 'canvas',
    render: () => <GridCard />,
  },
  {
    id: 'storage-inspector',
    group: 'Patterns',
    name: 'Storage inspector',
    subtitle:
      'Details with a JSON preview, Metadata with an edited field and a counted Save, Activity with changes, decisions and event bodies',
    width: 480,
    surface: 'canvas',
    render: () => <InspectorCard />,
  },
  {
    id: 'upload-tray',
    group: 'Patterns',
    name: 'Upload tray',
    subtitle:
      'The tray mid-upload with a failure, a queued file and a skipped name, and the conflict question for a drop',
    width: 720,
    surface: 'canvas',
    render: () => <UploadsCard />,
  },
  {
    id: 'storage-rules',
    group: 'Patterns',
    name: 'Storage rules',
    subtitle:
      'The Rules page with a refused upload open: the deciding lines lit, the values each expression had written in, the decisions beside them',
    width: 1440,
    surface: 'canvas',
    render: () => <RulesCard />,
  },
  {
    id: 'storage-rules-dark',
    group: 'Patterns',
    name: 'Storage rules, dark',
    subtitle: 'The same in dark mode',
    width: 1440,
    dark: true,
    surface: 'canvas',
    render: () => <RulesCard />,
  },
])
