// A zip's entries — name, size, compressed size — read by the engine from
// the central directory (the first 2,000), never by fetching the archive.

import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FileIcon, FolderIcon } from '@phosphor-icons/react'
import { useRef } from 'react'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { formatBytes, formatNumber } from '@/lib/format'
import { archiveQuery } from '../../queries'

const ROW = 24

export function PreviewArchive({
  object,
  project,
  large = false,
}: {
  object: StorageObjectDetail
  project: string
  large?: boolean
}) {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const archive = useQuery(archiveQuery(project, object.bucket, object.name, object.generation))
  const entries = archive.data?.entries ?? []
  const scroll = useRef<HTMLDivElement>(null)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW,
    overscan: 12,
  })
  if (archive.isError)
    return <p className="text-[13px] text-kumo-subtle">{archive.error.message}</p>
  if (!archive.data) return <div className="h-24 animate-pulse rounded-md bg-kumo-tint" />
  const total = entries.reduce((sum, entry) => sum + entry.size, 0)
  return (
    <div className="grid min-h-0 gap-1">
      <span className="text-[12px] text-kumo-subtle">
        <span className="font-mono tabular-nums">{formatNumber(archive.data.total)}</span>{' '}
        {archive.data.total === 1 ? 'entry' : 'entries'} · {formatBytes(total)}
      </span>
      <div
        ref={scroll}
        className={`overflow-auto rounded-md ring ring-kumo-line ${large ? 'h-full' : 'max-h-80'}`}
        data-testid="preview-archive"
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = entries[item.index]
            if (!entry) return null
            return (
              <div
                key={item.key}
                className="absolute inset-x-0 flex items-center gap-2 border-b border-kumo-hairline px-2"
                style={{ height: ROW, transform: `translateY(${item.start}px)` }}
                data-testid="archive-entry"
              >
                {entry.directory ? (
                  <FolderIcon size={13} className="shrink-0 text-kumo-subtle" />
                ) : (
                  <FileIcon size={13} className="shrink-0 text-kumo-subtle" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-kumo-default">
                  {entry.name}
                </span>
                {!entry.directory && (
                  <>
                    <span className="w-16 shrink-0 text-right font-mono text-[11px] text-kumo-subtle tabular-nums">
                      {formatBytes(entry.size)}
                    </span>
                    <span className="w-16 shrink-0 text-right font-mono text-[11px] text-kumo-inactive tabular-nums">
                      {formatBytes(entry.compressed)}
                    </span>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {archive.data.truncated && (
        <span className="text-[11px] text-kumo-subtle">
          The first {formatNumber(entries.length)} of {formatNumber(archive.data.total)}
        </span>
      )}
    </div>
  )
}
