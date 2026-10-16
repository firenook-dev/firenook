// Raw bytes as a hex view — offset, sixteen bytes, the ones that print —
// from the first 64 KB, virtualized; what the bytes are, when their first
// ones say, is the line above it.

import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { formatBytes } from '@/lib/format'
import { describeSignature, hexRows } from '../../content'
import { HEX_HEAD, readHead } from '../../media'
import { ST } from '../../queries'

const ROW = 20

export function PreviewHex({
  object,
  project,
  large = false,
}: {
  object: StorageObjectDetail
  project: string
  large?: boolean
}) {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const head = useQuery({
    queryKey: [ST, project, object.bucket, 'hex', object.name, object.generation],
    queryFn: ({ signal }) =>
      readHead({ ...object, gzip: object.contentEncoding === 'gzip' }, HEX_HEAD, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const rows = head.data ? hexRows(head.data.bytes) : []
  const scroll = useRef<HTMLDivElement>(null)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW,
    overscan: 16,
  })
  if (head.isError) return <p className="text-[13px] text-kumo-danger">{head.error.message}</p>
  return (
    <div className="grid min-h-0 gap-1">
      {object.sniffed?.definite && (
        <span className="text-[12px] text-kumo-subtle">
          The first bytes say: {describeSignature(object.sniffed.mime)}.
        </span>
      )}
      <div
        ref={scroll}
        className={`overflow-auto rounded-md bg-kumo-tint px-2 py-1 ${large ? 'h-full' : 'max-h-80'}`}
        data-testid="preview-hex"
      >
        {/* As wide as a row (offset, sixteen bytes, their text), so a narrow
            panel scrolls sideways instead of cutting the text column off. */}
        <div
          className="relative min-w-full font-mono text-[12px]"
          style={{ height: virtualizer.getTotalSize(), width: 'calc(72ch + 2.5rem)' }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            if (!row) return null
            return (
              <div
                key={item.key}
                className="absolute left-0 flex gap-3 font-mono text-[12px] leading-5 whitespace-pre"
                style={{ height: ROW, transform: `translateY(${item.start}px)` }}
                data-testid="hex-row"
              >
                <span className="text-kumo-inactive">{row.offset}</span>
                <span className="text-kumo-default">
                  {row.hex.slice(0, 8).join(' ')}
                  {'  '}
                  {row.hex.slice(8).join(' ').padEnd(23, ' ')}
                </span>
                <span className="text-kumo-subtle">{row.ascii}</span>
              </div>
            )
          })}
        </div>
      </div>
      {head.data && (
        <span className="text-[11px] text-kumo-subtle">
          {head.data.complete
            ? `All ${formatBytes(head.data.bytes.length)}`
            : `The first ${formatBytes(head.data.bytes.length)} of ${formatBytes(object.size)}`}
        </span>
      )}
    </div>
  )
}
