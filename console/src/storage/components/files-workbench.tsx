// The Files page: the folders panel in the shell's column, two toolbar rows
// — the scope (where you are, who you act as, what makes things) and this
// view (filter, count, order, layout) — the bucket's banners, and the list
// or grid. Everything on screen is the engine's, kept current by the
// console's one live channel: `storage.objects` patches the rows a write
// touched (or counts them for a sorted or filtered view), and refreshes the
// tree, the figures and the open object through a keyed throttle;
// `storage.rules` keeps the bucket's banners true.

import { Button } from '@cloudflare/kumo'
import {
  CopySimpleIcon,
  FolderSimpleDashedIcon as FolderDashedGlyph,
  HardDrivesIcon as HardDrivesGlyph,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { StorageEntry } from '@/api/generated/storage/StorageEntry'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import type { Total } from '@/api/generated/Total'
import { EmptyState, NoMatch, QueryError } from '@/components/console/empty-state'
import { FilterField } from '@/components/console/filter-field'
import { IdentityPicker } from '@/components/console/identity-picker'
import { LiveNotice } from '@/components/console/live-notice'
import { MatchCount } from '@/components/console/match-count'
import type { RowMenuItem } from '@/components/console/row-menu'
import { SectionBanner } from '@/components/console/section-banner'
import { SectionBody } from '@/components/console/section-page'
import { SelectionBar } from '@/components/console/selection-bar'
import { SectionToolbar, ToolbarDivider, ToolbarRow } from '@/components/console/toolbar'
import { PanelToggle } from '@/components/shell/section-panel'
import { formatBytes, formatNumber } from '@/lib/format'
import { liveChannel } from '@/lib/live/channel'
import { isTyping, useShortcuts } from '@/lib/shortcuts'
import { useAccess } from '../access'
import { StorageApiError, mediaUrl } from '../api'
import { copyText } from '../copy'
import { type EntryActions, entryMenu } from '../entry-menu'
import { useFiles } from '../files-state'
import { FILTER_PLACEHOLDER, filterFields } from '../filter'
import { type Listing, useListing } from '../listing'
import { useStorageObjectsLive, useStorageRulesLive } from '../live'
import { gsUrl } from '../paths'
import { folderQuery, objectsMetaQuery, profileQuery, rulesScope } from '../queries'
import { useStorageRecents, recentsKey } from '../recents'
import { resetFileSelection, selectionFigures, useFileSelection } from '../selection'
import { FileGrid } from './file-grid'
import { type FileRow, FileList, fileRows } from './file-list'
import { FoldersPanel } from './folders-panel'
import { FileInspector } from './inspector/file-inspector'
import { QuickLook } from './quick-look'
import { LayoutToggle } from './layout-toggle'
import { StoragePathBar } from './path-bar'
import { useRulesText } from './refusal-detail'
import { DeniedPanel } from './denied-panel'
import { SortMenu } from './sort-menu'

/** How long the filter waits after the last key before it goes into the URL. */
const FILTER_DEBOUNCE_MS = 300

/** The count slot's widest figures: a view that can go stale holds room for "N changes · Refresh" too. */
const WIDEST = '0,000,000'

/** What the page can do beyond what commit-by-commit features add. */
export interface FilesExtras {
  /** More actions for a row's menu. */
  entryActions?: Partial<EntryActions>
  /** More actions for the selection bar, before the destructive one. */
  selectionActions?: ReactNode
  /** Items for the panel's bucket menu. */
  bucketMenu?: ReactNode
  /** Row one's last group: the primary action. */
  primary?: ReactNode
  /** What a bucket that holds nothing offers. */
  emptyActions?: ReactNode
  /** Under the toolbar: job banners. */
  banners?: ReactNode
  /** More tools for the inspector's foot (download, move, duplicate). */
  inspectorTools?: (object: StorageObjectDetail) => ReactNode
  /** The inspector's destructive control. */
  inspectorDanger?: (object: StorageObjectDetail) => ReactNode
  /** Over the content column: the drop overlay, the upload tray. */
  overlay?: ReactNode
  /** Uploads in flight in this folder, by name (0–1), drawn in their rows. */
  progress?: ReadonlyMap<string, number>
}

const NO_EXTRAS: FilesExtras = {}

export function FilesWorkbench({ extras = NO_EXTRAS }: { extras?: FilesExtras }) {
  const files = useFiles()
  const listing = useListing(files)
  const live = useStorageObjectsLive(files.project, files.bucket, {
    onChanged: listing.apply,
    onReset: () => listing.refresh(),
  })
  useStorageRulesLive(
    files.project,
    files.buckets.rulesMode === null ? undefined : rulesScope(files.buckets, files.bucket),
  )

  // The ticks belong to one listing: another folder, filter, order or identity drops them.
  const selectionScope = `${files.bucket}|${files.prefix}|${files.flat}|${files.q}|${files.sort}|${files.search.as ?? ''}`
  useEffect(() => resetFileSelection(selectionScope), [selectionScope])

  // Where you have been, for ⌘K.
  const loadRecents = useStorageRecents((state) => state.load)
  const recordRecent = useStorageRecents((state) => state.record)
  useEffect(
    () => loadRecents(recentsKey(files.project, files.bucket)),
    [loadRecents, files.project, files.bucket],
  )
  useEffect(() => recordRecent(files.prefix, 'folder'), [recordRecent, files.prefix])
  useEffect(() => {
    if (files.object) recordRecent(files.object, 'file')
  }, [recordRecent, files.object])

  const access = useAccess(files.project, files.bucket, files.viewAs, listing.pages)
  const { line } = useRulesText()
  const rows = fileRows(listing.rows.rows, {
    prefix: files.prefix,
    flat: files.flat,
    access,
    lineText: line,
    progress: extras.progress,
  })

  // The files of the listing, in view order: the inspector's ↑ ↓ and Quick Look's ← →.
  const fileNames = rows.flatMap((row) => (row.entry.type === 'file' ? [row.key] : []))
  const openAt = files.object === undefined ? -1 : fileNames.indexOf(files.object)
  const step = (by: number) => {
    const next = openAt === -1 ? undefined : fileNames[openAt + by]
    return next === undefined ? undefined : () => files.openObject(next, { replace: true })
  }

  const [cursor, setCursor] = useState<StorageEntry | undefined>(undefined)
  const open = (entry: StorageEntry) => {
    if (entry.type === 'folder') files.goTo(entry.prefix)
    else files.openObject(entry.name)
  }
  const onCursor = (entry: StorageEntry) => {
    setCursor(entry)
    // An open inspector follows the cursor from file to file.
    if (files.object !== undefined && entry.type === 'file' && entry.name !== files.object)
      files.openObject(entry.name, { replace: true })
  }

  const actions: EntryActions = {
    open,
    openInNewTab: (entry) => {
      const url =
        entry.type === 'folder'
          ? `${window.location.pathname}?${new URLSearchParams({
              ...(files.search.bucket ? { bucket: files.search.bucket } : {}),
              path: entry.prefix,
            })}`
          : mediaUrl({ bucket: files.bucket, name: entry.name, generation: entry.generation })
      window.open(url, '_blank', 'noopener')
    },
    copyGsUrl: (entry) =>
      void copyText(
        gsUrl(files.bucket, entry.type === 'folder' ? entry.prefix : entry.name),
        'the gs:// URL',
      ),
    copyPath: (entry) =>
      void copyText(entry.type === 'folder' ? entry.prefix : entry.name, 'the path'),
    ...extras.entryActions,
  }
  const menu = (row: FileRow): readonly RowMenuItem[] => entryMenu(row.entry, actions)

  const checked = useFileSelection((state) => state.checked)
  const everything = useFileSelection((state) => state.everything)
  const clearSelection = useFileSelection((state) => state.clear)
  const selecting = checked.size > 0 || everything
  const filterRef = useRef<{ timer: ReturnType<typeof setTimeout> | undefined }>({
    timer: undefined,
  })
  useEffect(() => () => clearTimeout(filterRef.current.timer), [])

  useShortcuts({ id: 'storage', label: 'Storage' }, [
    {
      key: 'g',
      label: 'Flip between this folder and everything under it',
      run: () => files.update({ flat: !files.flat || undefined, object: undefined }),
    },
    {
      key: 'v',
      label: 'Flip between the list and the grid',
      run: () =>
        files.update({ layout: files.layout === 'list' ? 'grid' : undefined }, { replace: true }),
    },
    {
      key: 'Shift+Space',
      label: 'Quick Look on the file',
      when: () => cursor?.type === 'file' || files.object !== undefined,
      run: () => {
        const name = cursor?.type === 'file' ? cursor.name : files.object
        if (name !== undefined) files.update({ object: name, dialog: 'quick-look' })
      },
    },
    {
      key: 'Alt+Mod+c',
      label: 'Copy the path of the cursor row',
      when: () => cursor !== undefined,
      run: () => {
        if (cursor) actions.copyPath(cursor)
      },
    },
    {
      key: 'Escape',
      label: 'Close the file, then clear the ticks',
      allowInInputs: true,
      run: (event) => {
        if (isTyping(event.target)) (event.target as HTMLElement).blur()
        else if (files.object !== undefined) files.openObject(undefined)
        else if (selecting) clearSelection()
      },
    },
  ])

  const meta = useQuery(objectsMetaQuery(files.project))
  const profile = useQuery(profileQuery(files.project, files.bucket, files.prefix))
  const fields = filterFields(meta.data?.fields, profile.data)

  const count = useMatchFigures(listing)
  const figures = selectionFigures(listing.rows.rows, checked)
  const where = files.prefix === '' ? `gs://${files.bucket}` : files.prefix

  const bucket = files.buckets.buckets.find((entry) => entry.name === files.bucket)
  const notServed =
    files.buckets.rulesMode === 'perBucket' &&
    (!bucket || (!bucket.served && bucket.rulesFile === null))
  const dropped =
    files.buckets.rulesMode !== null &&
    bucket !== undefined &&
    !bucket.served &&
    bucket.rulesFile !== null

  return (
    <>
      <FoldersPanel menuItems={extras.bucketMenu} />
      <SectionToolbar>
        <ToolbarRow testId="storage-toolbar">
          <PanelToggle where="toolbar" />
          <StoragePathBar />
          <ToolbarDivider />
          <LiveNotice
            status={live}
            what="the list"
            onRetry={() => liveChannel.retry()}
            testId="storage-live"
          />
          <IdentityPicker
            project={files.project}
            value={files.viewAs}
            onChange={files.setViewAs}
            testId="identity-picker"
          />
          {extras.primary && (
            <>
              <ToolbarDivider />
              {extras.primary}
            </>
          )}
        </ToolbarRow>
        <ToolbarRow
          variant="line"
          testId="listing-line"
          overlay={
            selecting ? (
              <SelectionBar
                count={everything ? (count.total?.count ?? checked.size) : checked.size}
                total={count.total}
                everything={everything}
                filtered={Boolean(files.q.trim())}
                noun={{ one: 'item', other: 'items' }}
                detail={
                  !everything && figures.bytesKnown && figures.bytes > 0
                    ? formatBytes(figures.bytes)
                    : undefined
                }
                onSelectEverything={() =>
                  useFileSelection.getState().set(new Set(listing.rows.rows.map(entryKeyOf)), true)
                }
                onClear={clearSelection}
                actions={
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<CopySimpleIcon />}
                      disabled={everything}
                      onClick={() => void copyText([...checked].join('\n'), 'the paths')}
                      data-testid="selection-copy-paths"
                    >
                      Copy paths
                    </Button>
                    {extras.selectionActions}
                  </>
                }
              />
            ) : undefined
          }
        >
          <FilterField
            value={files.q}
            onChange={(text) => {
              clearTimeout(filterRef.current.timer)
              filterRef.current.timer = setTimeout(
                () =>
                  files.update(
                    { q: text.trim() ? text : undefined, object: undefined },
                    { replace: true },
                  ),
                FILTER_DEBOUNCE_MS,
              )
            }}
            fields={fields}
            placeholder={FILTER_PLACEHOLDER}
            ariaLabel="Filter the files"
            testId="storage-filter"
          />
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <span className="grid justify-items-end">
              {/* The slot is as wide as its widest figure, so the order and
                  layout controls never move when the count changes. */}
              <span
                aria-hidden
                className="invisible col-start-1 row-start-1 font-mono text-[12px] whitespace-nowrap"
              >
                {listing.fast
                  ? `${WIDEST} matching · 0,000.0 MB`
                  : `00,000 changes · Refresh ${WIDEST} matching · 0,000.0 MB`}
              </span>
              <span className="col-start-1 row-start-1">
                <MatchCount
                  total={count.total}
                  noun={count.noun}
                  loading={count.loading}
                  widest={WIDEST}
                  detail={count.detail}
                  tooltip={count.tooltip}
                  stale={
                    listing.fast ? undefined : { count: listing.stale, onRefresh: listing.refresh }
                  }
                  hidden={
                    listing.error instanceof StorageApiError &&
                    listing.error.code === 'invalid-argument'
                  }
                  testId="listing-count"
                />
              </span>
            </span>
            <SortMenu sortable={meta.data?.sortable} />
            <LayoutToggle />
          </span>
        </ToolbarRow>
      </SectionToolbar>
      {notServed && (
        <SectionBanner tone="warning" testId="bucket-not-served">
          No rules govern <span className="font-mono text-[0.9em]">gs://{files.bucket}</span>, so
          the emulator refuses every client request to it — the Admin SDK included. Add it to the{' '}
          <span className="font-mono text-[0.9em]">storage</span> targets in firebase.json.
        </SectionBanner>
      )}
      {dropped && (
        <SectionBanner tone="danger" testId="rules-dropped">
          The last rules reload did not compile, so the emulator has no Storage rules loaded and
          refuses every request. Apply rules on the Rules page.
        </SectionBanner>
      )}
      {extras.banners}
      <SectionBody>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="files-content">
          <Listed
            listing={listing}
            rows={rows}
            menu={menu}
            onOpen={open}
            onCursor={onCursor}
            sortable={meta.data?.sortable}
            where={where}
            emptyActions={extras.emptyActions}
          />
          {extras.overlay}
        </div>
        {files.object !== undefined && (
          <FileInspector
            key={`${files.bucket}|${files.search.as ?? ''}`}
            name={files.object}
            onPrev={step(-1)}
            onNext={step(1)}
            onQuickLook={() => files.update({ dialog: 'quick-look' })}
            tools={extras.inspectorTools}
            danger={extras.inspectorDanger}
          />
        )}
      </SectionBody>
      <QuickLook
        names={fileNames}
        hasMore={listing.rows.hasMore}
        loadMore={listing.rows.loadMore}
      />
    </>
  )
}

function entryKeyOf(entry: StorageEntry): string {
  return entry.type === 'folder' ? entry.prefix : entry.name
}

/** The list or the grid, or the state that stands in for them. */
function Listed({
  listing,
  rows,
  menu,
  onOpen,
  onCursor,
  sortable,
  where,
  emptyActions,
}: {
  listing: Listing
  rows: readonly FileRow[]
  menu: (row: FileRow) => readonly RowMenuItem[]
  onOpen: (entry: StorageEntry) => void
  onCursor: (entry: StorageEntry) => void
  sortable: readonly string[] | undefined
  where: string
  emptyActions?: ReactNode
}) {
  const files = useFiles()
  if (listing.error) {
    if (listing.error instanceof StorageApiError && listing.error.refused)
      return <DeniedPanel error={listing.error} what={where} />
    return <QueryError error={listing.error} onRetry={listing.retry} section="storage" />
  }
  const empty = (
    <EmptyListing
      where={where}
      placeholder={listing.page?.placeholder ?? false}
      actions={emptyActions}
    />
  )
  return files.layout === 'grid' ? (
    <FileGrid
      listing={listing}
      rows={rows}
      menu={menu}
      onOpen={onOpen}
      onCursor={onCursor}
      empty={empty}
    />
  ) : (
    <FileList
      listing={listing}
      rows={rows}
      sortable={sortable}
      menu={menu}
      onOpen={onOpen}
      onCursor={onCursor}
      empty={empty}
    />
  )
}

/** Nothing to list: the bucket, a folder marker, a filter that matches nothing. */
function EmptyListing({
  where,
  placeholder,
  actions,
}: {
  where: string
  placeholder: boolean
  actions?: ReactNode
}) {
  const files = useFiles()
  if (files.q.trim())
    return (
      <NoMatch
        filter={files.q}
        onClear={() => files.update({ q: undefined }, { replace: true })}
        noun="files"
      />
    )
  if (files.prefix === '' && !files.flat)
    return (
      <EmptyState
        icon={HardDrivesGlyph}
        title={`Nothing in gs://${files.bucket} yet`}
        description="Drop files or folders here, or upload from your app."
        commandLine={`ref(getStorage(app, 'gs://${files.bucket}'), 'path/to/file')`}
        connect={{ service: 'storage' }}
        actions={actions}
        testId="bucket-empty"
      />
    )
  if (placeholder && !files.flat)
    return (
      <EmptyState
        icon={FolderDashedGlyph}
        title="This folder is empty"
        description={`It exists as a zero-byte marker object named ${files.prefix} (consoles create one for a new folder); your app's list() sees the marker until you delete the folder.`}
        actions={actions}
        testId="folder-empty"
      />
    )
  return (
    <EmptyState
      icon={FolderDashedGlyph}
      title={files.flat ? `No files under ${where}` : `Nothing in ${where}`}
      description="Everything that was here has gone; the folder exists only while something is in it."
      actions={actions}
      testId="folder-empty"
    />
  )
}

/** What the count slot says, from the folder index while unfiltered and the view's totals when filtered. */
function useMatchFigures(listing: Listing): {
  total: Total | undefined
  noun: { one: string; other: string }
  detail: string | undefined
  tooltip: string | undefined
  loading: boolean
} {
  const files = useFiles()
  const filtered = Boolean(files.q.trim())
  const folder = useQuery({
    ...folderQuery(files.project, files.bucket, files.prefix),
    enabled: !filtered,
  })
  const where = files.prefix === '' ? `gs://${files.bucket}` : files.prefix
  if (filtered) {
    const totals = listing.page?.totals
    const count = totals ? (totals.files ?? 0) + (totals.folders ?? 0) : undefined
    return {
      total: count === undefined ? undefined : { count, exact: true },
      noun: { one: 'matching', other: 'matching' },
      detail: totals?.bytes ? formatBytes(totals.bytes) : undefined,
      tooltip: `Every file${files.flat ? '' : ' and folder'} this filter matches ${files.flat ? 'under' : 'in'} ${where}, not only the rows loaded.`,
      loading: listing.pending,
    }
  }
  const data = folder.data
  if (!data)
    return {
      total: undefined,
      noun: { one: 'file', other: 'files' },
      detail: undefined,
      tooltip: undefined,
      loading: true,
    }
  if (files.flat)
    return {
      total: { count: data.objects, exact: true },
      noun: { one: 'file', other: 'files' },
      detail: data.objects > 0 ? formatBytes(data.bytes) : undefined,
      tooltip: `${formatNumber(data.objects)} files · ${formatBytes(data.bytes)} at any depth under ${where} — every one, not only the rows loaded.`,
      loading: false,
    }
  const summary = `${formatNumber(data.folders)} ${data.folders === 1 ? 'folder' : 'folders'} · ${formatNumber(data.directFiles)} ${data.directFiles === 1 ? 'file' : 'files'} · ${formatBytes(data.directBytes)} directly in ${where} — every match, not only the rows loaded.`
  if (data.directFiles === 0 && data.folders > 0)
    return {
      total: { count: data.folders, exact: true },
      noun: { one: 'folder', other: 'folders' },
      detail: undefined,
      tooltip: summary,
      loading: false,
    }
  return {
    total: { count: data.directFiles, exact: true },
    noun: { one: 'file', other: 'files' },
    detail: data.directFiles > 0 ? formatBytes(data.directBytes) : undefined,
    tooltip: summary,
    loading: false,
  }
}
