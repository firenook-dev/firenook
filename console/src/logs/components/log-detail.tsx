// What an open row shows under its line (→, or its caret): the rest of a
// multi-line message — a stack trace, a pretty-printed object — wrapped in
// place, and the payload's tree, whose values each offer "filter" (the
// Google UI's click-to-filter: `payload.cartId:"c_19"`). It sits in the
// row's own columns, under the message, with the level's rail carried on
// down beside it.

import { cn } from '@cloudflare/kumo'
import type { LogEntry } from '@/api/generated/observe/LogEntry'
import { JsonTree } from '@/components/console/json-tree'
import type { JsonPath } from '@/components/console/json-tree-model'
import type { Highlighter } from '../highlight'
import { Highlighted } from './highlighted'

const RAIL: Partial<Record<LogEntry['level'], string>> = {
  warn: 'before:bg-kumo-warning',
  error: 'before:bg-kumo-danger',
}

export function LogDetail({
  entry,
  wrap,
  highlight,
  onFilter,
}: {
  entry: LogEntry
  /** The row already shows the whole message (wrap mode). */
  wrap: boolean
  highlight: Highlighter | undefined
  onFilter: (path: JsonPath, value: unknown) => void
}) {
  const newline = entry.message.indexOf('\n')
  const rest = !wrap && newline !== -1 ? entry.message.slice(newline + 1) : ''
  const rail = RAIL[entry.level]
  return (
    // What is pressed in here (a tree's row, its strip) is the tree's, not
    // a press on the row that would move the cursor or the inspector.
    <div
      className="grid grid-cols-[104px_44px_var(--log-source-width,120px)_minmax(0,1fr)] gap-x-2 pr-3 pb-2 pl-3"
      onClick={(event) => event.stopPropagation()}
      data-testid="log-detail"
    >
      <span
        className={cn(
          'relative col-start-2 self-stretch',
          rail && cn('before:absolute before:inset-y-0 before:left-0 before:w-0.5', rail),
        )}
        aria-hidden
      />
      <div className="col-start-4 grid min-w-0 gap-2">
        {rest && (
          <pre
            className="m-0 font-mono text-[12px] leading-4 break-words whitespace-pre-wrap text-kumo-subtle"
            data-testid="log-detail-message"
          >
            {highlight ? <Highlighted text={rest} highlight={highlight} /> : rest}
          </pre>
        )}
        {entry.payload !== undefined && (
          <div className="-ml-2 min-w-0" data-testid="log-detail-payload">
            <JsonTree
              value={entry.payload}
              defaultDepth={1}
              onFilter={onFilter}
              ariaLabel="Payload"
              testId="payload-tree"
            />
          </div>
        )}
      </div>
    </div>
  )
}
