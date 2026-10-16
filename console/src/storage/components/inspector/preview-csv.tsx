// A CSV as a table: its first 1,000 rows, quoted commas and line breaks
// kept whole, the first row as the header, virtualized like every list.

import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import { formatNumber } from '@/lib/format'
import { parseCsv } from '../../content'

const ROW = 22

export function PreviewCsv({
  text,
  separator = ',',
  large = false,
}: {
  text: string
  separator?: string
  large?: boolean
}) {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const { rows, truncated } = parseCsv(text, { separator })
  const [header = [], ...body] = rows
  const sample = [header, ...body.slice(0, 50)]
  const columns = Math.max(...sample.map((row) => row.length))
  // One width per column for every row, from the header and the first
  // rows, so the columns line up; a long value is cut, not the column.
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.min(40, Math.max(6, ...sample.map((row) => (row[index] ?? '').length))),
  )
  const scroll = useRef<HTMLDivElement>(null)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: body.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW,
    overscan: 12,
  })
  const grid = {
    gridTemplateColumns: `3rem ${widths.map((width) => `calc(${width}ch + 1rem)`).join(' ')}`,
  }
  return (
    <div className="grid min-h-0 gap-1">
      <div
        ref={scroll}
        className={`overflow-auto rounded-md font-mono text-[11px] ring ring-kumo-line ${large ? 'h-full' : 'max-h-80'}`}
        data-testid="preview-csv"
      >
        <div className="sticky top-0 z-[1] grid w-max min-w-full bg-kumo-elevated" style={grid}>
          <span className="px-2 py-1 font-mono text-[11px] text-kumo-inactive">#</span>
          {Array.from({ length: columns }, (_, index) => (
            <span
              // A header's place is its identity; two may share a name.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className="truncate border-l border-kumo-hairline px-2 py-1 font-mono text-[11px] font-medium text-kumo-default"
            >
              {header[index] ?? ''}
            </span>
          ))}
        </div>
        <div className="relative w-max min-w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = body[item.index] ?? []
            return (
              <div
                key={item.key}
                className="absolute inset-x-0 grid border-t border-kumo-hairline"
                style={{ ...grid, height: ROW, transform: `translateY(${item.start}px)` }}
                data-testid="preview-csv-row"
              >
                <span className="px-2 font-mono text-[11px] leading-[22px] text-kumo-inactive tabular-nums">
                  {item.index + 1}
                </span>
                {Array.from({ length: columns }, (_, index) => (
                  <span
                    // A cell's place in its row is its identity.
                    // oxlint-disable-next-line react/no-array-index-key
                    key={index}
                    className="truncate border-l border-kumo-hairline px-2 font-mono text-[11px] leading-[22px] text-kumo-default"
                  >
                    {row[index] ?? ''}
                  </span>
                ))}
              </div>
            )
          })}
        </div>
      </div>
      <span className="text-[11px] text-kumo-subtle">
        {truncated
          ? `The first ${formatNumber(body.length)} rows`
          : `${formatNumber(body.length)} ${body.length === 1 ? 'row' : 'rows'}`}
      </span>
    </div>
  )
}
