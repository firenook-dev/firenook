// The tab's uploads, bottom right of the content: the total and each file —
// its progress, Cancel while it sends, why it failed or was refused (with
// See why), Retry — and the whole queue's Cancel all and Retry. It survives
// moving around the console (the queue is the tab's), collapses to its
// header, and folds away by itself a few seconds after everything went
// through. Virtualized past fifty rows; finished rows past a thousand are
// dropped, their counts kept.

import { Button, LayerCard, Tooltip, cn } from '@cloudflare/kumo'
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckIcon,
  CircleNotchIcon,
  MinusCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import { formatBytes, formatNumber } from '@/lib/format'
import type { StorageErrorExtras } from '../api'
import { baseName } from '../paths'
import { type UploadItem, inFlight, isActive, useUploadQueue } from '../upload-queue-store'
import {
  canRetry,
  cancelAllUploads,
  cancelUpload,
  clearFinishedUploads,
  retryFailedUploads,
  retryUpload,
} from '../uploads'
import { RefusalDetail } from './refusal-detail'

const ROW = 30
/** Rows drawn without a virtualizer below this. */
const PLAIN_ROWS = 50
/** How long an all-green tray stays open after the last upload. */
const FOLD_AFTER_MS = 4_000

/** The header's sentence: what is going on, in one line. */
export function traySummary(
  items: readonly UploadItem[],
  totals: { files: number; finished: number },
): string {
  const active = items.filter(isActive).length
  const failed = items.filter((item) => item.state === 'failed' || item.state === 'refused').length
  if (active > 0)
    return `Uploading · ${formatNumber(totals.finished)} of ${formatNumber(totals.files)} done`
  if (failed > 0)
    return `${formatNumber(failed)} ${failed === 1 ? 'upload' : 'uploads'} did not go through`
  const done = items.filter((item) => item.state === 'done').length
  return `Uploaded ${formatNumber(done)} ${done === 1 ? 'file' : 'files'}`
}

function Bar({ value, tone = 'brand' }: { value: number; tone?: 'brand' | 'danger' }) {
  return (
    <span
      className="block h-1 w-full overflow-hidden rounded-full bg-kumo-tint"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      <span
        className={cn('block h-full', tone === 'danger' ? 'bg-kumo-danger' : 'bg-kumo-brand')}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </span>
  )
}

function Glyph({ item }: { item: UploadItem }) {
  if (item.state === 'done') return <CheckIcon size={13} className="shrink-0 text-kumo-success" />
  if (item.state === 'uploading' || item.state === 'checking')
    return <CircleNotchIcon size={13} className="shrink-0 animate-spin text-kumo-subtle" />
  if (item.state === 'queued')
    return <span className="size-3 shrink-0 rounded-full border border-kumo-line" />
  if (item.state === 'skipped' || item.state === 'cancelled')
    return <MinusCircleIcon size={13} className="shrink-0 text-kumo-subtle" />
  return <XIcon size={13} className="shrink-0 text-kumo-danger" />
}

function Row({ item }: { item: UploadItem }) {
  const sending = item.state === 'uploading'
  const bad = item.state === 'failed' || item.state === 'refused'
  return (
    <div
      className="grid h-[30px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3"
      data-testid="tray-row"
      data-state={item.state}
    >
      <Glyph item={item} />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <Tooltip
            content={item.name}
            render={
              <span className="min-w-0 truncate font-mono text-[12px] text-kumo-default">
                {baseName(item.name)}
              </span>
            }
          />
          {item.message ? (
            <span
              className={cn(
                'min-w-0 shrink truncate text-[11px]',
                bad ? 'text-kumo-danger' : 'text-kumo-subtle',
              )}
              data-testid="tray-row-message"
            >
              {item.message}
            </span>
          ) : (
            <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
              {sending && item.size > 0
                ? `${Math.round((item.loaded / item.size) * 100)}%`
                : formatBytes(item.size)}
            </span>
          )}
        </span>
        {sending && <Bar value={item.size > 0 ? item.loaded / item.size : 0} />}
      </span>
      <span className="flex items-center">
        {item.state === 'refused' && item.refusal !== undefined && (
          <RefusalDetail
            extras={item.refusal as StorageErrorExtras}
            trigger={
              <Button variant="ghost" size="xs" data-testid="tray-see-why">
                See why
              </Button>
            }
          />
        )}
        {(item.state === 'failed' || item.state === 'cancelled') && canRetry(item.id) && (
          <Button
            variant="ghost"
            size="xs"
            icon={<ArrowClockwiseIcon />}
            onClick={() => retryUpload(item.id)}
          >
            Retry
          </Button>
        )}
        {isActive(item) && (
          <Tooltip
            content="Cancel this upload"
            render={
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={<XIcon />}
                aria-label={`Cancel ${baseName(item.name)}`}
                onClick={() => cancelUpload(item.id)}
                data-testid="tray-cancel"
              />
            }
          />
        )}
      </span>
    </div>
  )
}

function Rows({ items }: { items: readonly UploadItem[] }) {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const scroll = useRef<HTMLDivElement>(null)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW,
    overscan: 8,
  })
  if (items.length <= PLAIN_ROWS)
    return (
      <div className="max-h-64 overflow-y-auto py-1">
        {items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </div>
    )
  return (
    <div ref={scroll} className="h-64 overflow-y-auto py-1">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          const item = items[virtual.index]
          if (!item) return null
          return (
            <div
              key={item.id}
              className="absolute inset-x-0"
              style={{ transform: `translateY(${virtual.start}px)` }}
            >
              <Row item={item} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function UploadTray({ sessionsLine }: { sessionsLine?: React.ReactNode }) {
  const items = useUploadQueue((state) => state.items)
  const totals = useUploadQueue((state) => state.totals)
  const collapsed = useUploadQueue((state) => state.collapsed)
  const open = useUploadQueue((state) => state.open)
  const setCollapsed = useUploadQueue((state) => state.setCollapsed)
  const close = useUploadQueue((state) => state.close)
  const flight = inFlight(items)
  const failed = items.filter(
    (item) => item.state === 'failed' || (item.state === 'cancelled' && canRetry(item.id)),
  ).length
  const allGreen =
    flight.count === 0 && items.length > 0 && items.every((item) => item.state === 'done')

  // Everything went through: fold away after a moment.
  useEffect(() => {
    if (!allGreen) return undefined
    const timer = window.setTimeout(() => setCollapsed(true), FOLD_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [allGreen, setCollapsed])

  if (!open || items.length === 0) return null
  const sent = totals.sentBytes + flight.loaded
  const share = totals.bytes > 0 ? sent / totals.bytes : flight.count === 0 ? 1 : 0
  return (
    <LayerCard
      className="absolute right-3 bottom-3 z-30 w-[360px] overflow-hidden rounded-xl bg-kumo-base p-0 shadow-md ring ring-kumo-line"
      data-testid="upload-tray"
    >
      <div className="grid gap-1.5 border-b border-kumo-line px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate text-[13px] text-kumo-default"
            data-testid="tray-summary"
          >
            {traySummary(items, totals)}
            {flight.count > 0 && (
              <span className="text-kumo-subtle"> · {Math.round(share * 100)}%</span>
            )}
          </span>
          <Button
            variant="ghost"
            size="xs"
            shape="square"
            icon={collapsed ? <CaretUpIcon /> : <CaretDownIcon />}
            aria-label={collapsed ? 'Show the uploads' : 'Fold the uploads'}
            onClick={() => setCollapsed(!collapsed)}
            data-testid="tray-collapse"
          />
          <Tooltip
            content={flight.count > 0 ? 'Fold it away; uploads keep going' : 'Close'}
            render={
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={<XIcon />}
                aria-label="Close the uploads"
                onClick={() => {
                  if (flight.count === 0) clearFinishedUploads()
                  close()
                }}
                data-testid="tray-close"
              />
            }
          />
        </div>
        {!collapsed && (
          <div className="grid gap-1">
            <Bar value={share} tone={failed > 0 && flight.count === 0 ? 'danger' : 'brand'} />
            <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
              {formatBytes(sent)} of {formatBytes(totals.bytes)}
            </span>
          </div>
        )}
      </div>
      {!collapsed && (
        <>
          <Rows items={items} />
          {sessionsLine}
          {(failed > 0 || flight.count > 0) && (
            <div className="flex items-center justify-between gap-2 border-t border-kumo-line px-3 py-1.5">
              {failed > 0 ? (
                <Button
                  variant="ghost"
                  size="xs"
                  icon={<ArrowClockwiseIcon />}
                  onClick={retryFailedUploads}
                  data-testid="tray-retry"
                >
                  Retry {formatNumber(failed)} failed
                </Button>
              ) : (
                <span />
              )}
              {flight.count > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={cancelAllUploads}
                  data-testid="tray-cancel-all"
                >
                  Cancel all
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </LayerCard>
  )
}
