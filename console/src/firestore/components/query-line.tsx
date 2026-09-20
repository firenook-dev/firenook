// The query line: the SDK chain you would write in code, run against the
// same engine query the app runs, with the index count beside it. It stays
// out of the way while browsing and opens on `f` or the filter button.

import { Badge, Button, Text, Tooltip } from '@cloudflare/kumo'
import { FunnelIcon, PlayIcon, XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { type WorkbenchQuery, isEmptyQuery, printLiteral, printQuery } from '../query'
import { countQueryOptions } from '../queries'
import { formatNumber } from '../value'
import { CodePopover } from './code-popover'
import { ViewAsPicker } from './view-as-picker'
import { useWorkbench } from './workbench-context'

export function QueryLine({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
  const workbench = useWorkbench()
  const [draft, setDraft] = useState(workbench.queryText)
  const [base, setBase] = useState(workbench.queryText)
  const inputRef = useRef<HTMLInputElement>(null)

  // A new query in the URL replaces the draft (derived during render).
  if (base !== workbench.queryText) {
    setBase(workbench.queryText)
    setDraft(workbench.queryText)
  }
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const count = useQuery({
    ...countQueryOptions(
      workbench.scope,
      workbench.collectionPath,
      workbench.group,
      workbench.query,
    ),
    enabled: Boolean(workbench.collectionPath) && !workbench.queryError,
  })

  const run = () => workbench.setQueryText(draft)
  const remove = (patch: (query: WorkbenchQuery) => WorkbenchQuery) =>
    workbench.setQuery(patch(workbench.query))

  const active = !isEmptyQuery(workbench.query)
  return (
    <div className="grid gap-2" data-testid="query-line">
      <div className="flex min-h-8 items-center gap-2">
        {open ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex h-lh items-center text-kumo-subtle">
              <FunnelIcon size={16} />
            </span>
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  run()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  if (!active && !draft) setOpen(false)
                  else setDraft(workbench.queryText)
                }
              }}
              placeholder='where("status", "==", "paid").orderBy("createdAt", "desc").limit(50)'
              spellCheck={false}
              autoComplete="off"
              className={`h-8 min-w-0 flex-1 rounded-md bg-kumo-control px-2.5 font-mono text-[0.9em] text-kumo-default ring outline-none placeholder:text-kumo-inactive focus:ring-kumo-focus ${
                workbench.queryError ? 'ring-kumo-danger' : 'ring-kumo-line'
              }`}
              aria-label="Query"
              data-testid="query-input"
            />
            <Button variant="primary" size="sm" icon={<PlayIcon />} onClick={run}>
              Run
            </Button>
            {(active || draft) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft('')
                  workbench.setQueryText('')
                }}
              >
                Clear
              </Button>
            )}
          </div>
        ) : (
          <Button
            variant={active ? 'secondary' : 'ghost'}
            size="sm"
            icon={<FunnelIcon />}
            onClick={() => setOpen(true)}
            aria-label="Filter"
          >
            {active ? printQuery(workbench.query) : 'Filter'}
            {!active && (
              <kbd className="ml-1 rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px] text-kumo-subtle">
                f
              </kbd>
            )}
          </Button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {workbench.collectionPath && !workbench.queryError && (
            <Text variant="secondary" size="sm" as="span" data-testid="match-count">
              {count.data ? (
                <>
                  <span className="font-mono text-[0.95em] text-kumo-default tabular-nums">
                    {formatNumber(count.data.count)}
                  </span>{' '}
                  {count.data.count === 1 ? 'document' : 'documents'}
                  <span className="text-kumo-inactive">
                    {' '}
                    · count {Math.max(1, Math.round(count.data.elapsedMs))} ms
                  </span>
                </>
              ) : count.isError ? (
                <span className="text-kumo-danger">count unavailable</span>
              ) : (
                '…'
              )}
            </Text>
          )}
          <CodePopover />
          <ViewAsPicker />
        </div>
      </div>
      {workbench.queryError && (
        <Text variant="error" size="sm">
          {workbench.queryError}
        </Text>
      )}
      {open && active && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips(workbench.query).map((chip) => (
            <Chip key={chip.key} onRemove={() => remove(chip.without)}>
              {chip.label}
            </Chip>
          ))}
          {workbench.query.limit !== 100 && (
            <Chip onRemove={() => remove((query) => ({ ...query, limit: 100 }))}>
              limit {workbench.query.limit}
            </Chip>
          )}
          {workbench.group && (
            <Tooltip content="Collection group: every collection with this id">
              <Badge variant="outline">group</Badge>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}

interface ClauseChip {
  key: string
  label: string
  without: (query: WorkbenchQuery) => WorkbenchQuery
}

/** One removable chip per clause; a repeated clause gets a distinct key. */
function chips(query: WorkbenchQuery): ClauseChip[] {
  const seen = new Map<string, number>()
  const unique = (label: string) => {
    const count = seen.get(label) ?? 0
    seen.set(label, count + 1)
    return count === 0 ? label : `${label}#${count}`
  }
  return [
    ...query.where.map((clause, index) => {
      const label = `${clause.field} ${clause.op} ${printLiteral(clause.value)}`
      return {
        key: unique(label),
        label,
        without: (current: WorkbenchQuery) => ({
          ...current,
          where: current.where.filter((_, i) => i !== index),
        }),
      }
    }),
    ...query.orderBy.map((order, index) => {
      const label = `orderBy ${order.field} ${order.direction}`
      return {
        key: unique(label),
        label,
        without: (current: WorkbenchQuery) => ({
          ...current,
          orderBy: current.orderBy.filter((_, i) => i !== index),
        }),
      }
    }),
  ]
}

function Chip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <span className="flex h-6 items-center gap-1 rounded-md bg-kumo-tint pr-0.5 pl-2 font-mono text-[12px] text-kumo-default">
      {children}
      <button
        type="button"
        onClick={onRemove}
        className="flex size-5 items-center justify-center rounded text-kumo-subtle hover:bg-kumo-base hover:text-kumo-default"
        aria-label="Remove clause"
      >
        <XIcon size={12} />
      </button>
    </span>
  )
}
