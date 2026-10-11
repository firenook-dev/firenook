// The query line: the SDK chain you would write in code, run against the
// same engine query the app runs, with the index count beside it. It stays
// out of the way while browsing and opens on `f` or the filter button.

import { Badge, Button, Text, Tooltip } from '@cloudflare/kumo'
import { FunnelIcon, InfoIcon, LightningIcon, PlayIcon, XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
  EMPTY_QUERY,
  type WorkbenchQuery,
  isEmptyQuery,
  presenceFields,
  printLiteral,
  printQuery,
} from '../query'
import { useQueryLine } from '../query-line-store'
import { countQueryOptions } from '../queries'
import { findNode, schemaQuery } from '../schema'
import { formatNumber } from '../value'
import { useWorkbench } from './workbench-context'

export function QueryLine() {
  const workbench = useWorkbench()
  const openState = useQueryLine((state) => state.open)
  const setOpen = useQueryLine((state) => state.setOpen)
  const prefill = useQueryLine((state) => state.prefill)
  const explain = useQueryLine((state) => state.explain)
  const setExplain = useQueryLine((state) => state.setExplain)
  // An active query always shows its line, and so does a broken one: the
  // text that failed to parse is in the URL, so the input has to be there to
  // fix it rather than collapsed behind the filter button.
  const open = openState || !isEmptyQuery(workbench.query) || Boolean(workbench.queryError)
  const [draft, setDraft] = useState(workbench.queryText)
  const [base, setBase] = useState(workbench.queryText)
  const [seenPrefill, setSeenPrefill] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // A new query in the URL replaces the draft (derived during render).
  if (base !== workbench.queryText) {
    setBase(workbench.queryText)
    setDraft(workbench.queryText)
  }
  // Text composed elsewhere (a column header) replaces it too.
  if (prefill && prefill.session !== seenPrefill) {
    setSeenPrefill(prefill.session)
    setDraft(prefill.text)
  }
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])
  // ...with the caret where the composer wanted it.
  useEffect(() => {
    const input = inputRef.current
    const current = useQueryLine.getState().prefill
    if (!input || !current || current.session !== seenPrefill) return
    input.focus()
    input.setSelectionRange(current.caret, current.caret)
  }, [seenPrefill])

  const { total, failed } = useMatchCount()

  // Sorting by a field, or comparing it with `!=`, drops every document
  // without it, and a grid of what is left looks complete. When sorting is
  // all the query does, the collection's own count says exactly how many
  // went; with a filter as well the two cannot be told apart, so the note
  // says what happens without a number.
  const absent = presenceFields(workbench.query)
  const sortedOnly = workbench.query.where.length === 0
  const whole = useQuery({
    ...countQueryOptions(workbench.scope, workbench.collectionPath, workbench.group, EMPTY_QUERY),
    enabled: absent.length > 0 && sortedOnly && !workbench.queryError,
  })
  const leftOut =
    sortedOnly && whole.data && total ? Math.max(0, whole.data.count - total.count) : undefined

  const run = () => workbench.setQueryText(draft)
  const remove = (patch: (query: WorkbenchQuery) => WorkbenchQuery) =>
    workbench.setQuery(patch(workbench.query))

  const active = !isEmptyQuery(workbench.query)
  return (
    <div className="grid shrink-0 border-b border-kumo-line bg-kumo-base" data-testid="query-line">
      {/* The padding is the scroller's own, not the line's: a scroller clips
          at its padding edge, and the field's outline is a ring painted
          outside its box. With the padding outside, the field was exactly
          as tall as the box clipping it — 28 px in 28 px — and focus showed
          as two brackets with no top or bottom. The minimum height is the
          field's, with the padding on top of it (`box-content`): counted
          inside it, the row shut around the 23 px Filter button and grew
          5 px when the field opened, pushing the grid down. */}
      <div className="box-content flex min-h-8 items-center gap-2 overflow-x-auto px-3 py-1.5">
        {open ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {/* The field is built like the path field a row above: one box,
                with no chrome at rest — the funnel and the chain say what it
                is — a ground under the pointer, and the outline kept for
                focus, or for a query that did not parse. The one control
                that acts on the whole query, clearing it, sits inside
                against the right edge, where the path keeps its copy. */}
            <div
              className={`flex h-8 min-w-0 flex-1 items-center rounded-lg pr-0.5 focus-within:bg-kumo-control focus-within:ring focus-within:ring-kumo-focus hover:not-focus-within:bg-kumo-tint ${
                workbench.queryError ? 'ring ring-kumo-danger' : ''
              }`}
              data-testid="query-field"
            >
              <label className="flex h-full min-w-0 flex-1 cursor-text items-center pl-2">
                <FunnelIcon size={14} className="shrink-0 text-kumo-subtle" />
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
                  className="h-full min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[12px] text-kumo-default outline-none placeholder:text-kumo-inactive"
                  aria-label="Query"
                  data-testid="query-input"
                />
              </label>
              {(active || draft) && (
                <Tooltip
                  content="Clear the query"
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      icon={<XIcon />}
                      aria-label="Clear the query"
                      className="h-7 w-7 shrink-0"
                      onClick={() => {
                        setDraft('')
                        workbench.setQueryText('')
                        inputRef.current?.focus()
                      }}
                      data-testid="query-clear"
                    />
                  }
                />
              )}
            </div>
            <Button variant="primary" size="sm" icon={<PlayIcon />} onClick={run}>
              Run
            </Button>
            {/* Firestore's own name for it, which says nothing to anyone
                who has not met Query Explain; the tip says what it finds. */}
            <Tooltip
              content="What this query reads, and the index production needs"
              render={
                <Button
                  variant={explain ? 'secondary' : 'ghost'}
                  size="sm"
                  icon={<LightningIcon />}
                  onClick={() => setExplain(!explain)}
                  aria-label="Explain this query"
                  data-testid="explain-toggle"
                >
                  Explain
                </Button>
              }
            />
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
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2 whitespace-nowrap">
          {workbench.collectionPath && (
            // A query that did not parse has nothing to count, but the slot
            // stays, so Run does not move while the text is fixed.
            <MatchCount
              total={total}
              failed={failed}
              hidden={Boolean(workbench.queryError)}
              scope={
                active
                  ? 'Every document this query matches'
                  : workbench.group || workbench.isPattern
                    ? 'Every document in this collection group'
                    : 'Every document in this collection'
              }
            />
          )}
        </div>
      </div>
      {workbench.queryError && (
        <div className="px-3 pb-1.5">
          <Text variant="error" size="sm">
            {workbench.queryError}
          </Text>
        </div>
      )}
      {open && active && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
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
              <Badge variant="outline">collection group</Badge>
            </Tooltip>
          )}
          {absent.length > 0 && leftOut !== 0 && (
            <span
              className="flex items-center gap-1 pl-1 text-[12px] text-kumo-subtle"
              data-testid="query-leaves-out"
            >
              <InfoIcon size={13} className="shrink-0" />
              <span>
                {leftOut === undefined
                  ? 'Documents without '
                  : `${formatNumber(leftOut)} ${leftOut === 1 ? 'document' : 'documents'} without `}
                {absent.map((field, index) => (
                  <span key={field}>
                    {index > 0 && (index === absent.length - 1 ? ' or ' : ', ')}
                    <span className="font-mono">{field}</span>
                  </span>
                ))}{' '}
                {leftOut === 1 ? 'is' : 'are'} left out. Firestore only returns documents that have
                a field the query {sortedOnly ? 'sorts' : 'sorts or compares'} by.
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * How many documents the query in the URL matches — the figure beside the
 * query line, and what the selection bar's "Select all" selects.
 */
export function useMatchCount(): {
  total: { count: number; elapsedMs: number | undefined } | undefined
  failed: boolean
} {
  const workbench = useWorkbench()
  // An unfiltered pattern is counted by the schema tree, which already has
  // the exact figure; counting the group index again would walk every entry.
  const fromSchema = workbench.isPattern && !workbench.queryText
  const count = useQuery({
    ...countQueryOptions(
      workbench.scope,
      workbench.collectionPath,
      workbench.group,
      workbench.query,
    ),
    enabled: Boolean(workbench.collectionPath) && !workbench.queryError && !fromSchema,
  })
  const schema = useQuery({ ...schemaQuery(workbench.database), enabled: fromSchema })
  const known = fromSchema ? findNode(schema.data, workbench.collectionPath) : undefined
  const total = known
    ? { count: known.documents, elapsedMs: undefined }
    : count.data
      ? { count: count.data.count, elapsedMs: count.data.elapsedMs }
      : undefined
  return { total, failed: count.isError || schema.isError }
}

/**
 * How many documents the query matches, in a slot as wide as a seven-digit
 * count. The field beside it takes whatever the row has left, so a count
 * that grew or shrank moved Run and Explain with it: 240 to 67 documents
 * slid Run 12 px under the pointer. The slot is sized by an invisible
 * `0,000,000 documents` in the same cell, in the same type, so it holds
 * whatever the font; a count past seven digits still widens it.
 *
 * How long the count took is in the tip. It was printed beside the figure
 * as `count 19 ms`, which read as a second number nobody could place.
 */
function MatchCount({
  total,
  failed,
  hidden,
  scope,
}: {
  total: { count: number; elapsedMs: number | undefined } | undefined
  failed: boolean
  hidden: boolean
  /** What the figure counts, for the tip. */
  scope: string
}) {
  return (
    <span className="grid justify-items-end">
      <span aria-hidden className="invisible col-start-1 row-start-1">
        <Figure number="0,000,000" noun="documents" />
      </span>
      {hidden ? null : total ? (
        <Tooltip
          content={`${scope}, not only the rows loaded. ${
            total.elapsedMs === undefined
              ? "From the schema tree's count."
              : `Counted in ${Math.max(1, Math.round(total.elapsedMs))} ms.`
          }`}
          render={
            <span className="col-start-1 row-start-1 cursor-default" data-testid="match-count">
              <Figure
                number={formatNumber(total.count)}
                noun={total.count === 1 ? 'document' : 'documents'}
              />
            </span>
          }
        />
      ) : (
        <span className="col-start-1 row-start-1" data-testid="match-count">
          <Text variant="secondary" size="sm" as="span" DANGEROUS_className="text-[12px]">
            {failed ? <span className="text-kumo-danger">Count unavailable</span> : '…'}
          </Text>
        </span>
      )}
    </span>
  )
}

function Figure({ number, noun }: { number: string; noun: string }) {
  return (
    <Text variant="secondary" size="sm" as="span" DANGEROUS_className="text-[12px]">
      <span className="font-mono text-[0.95em] text-kumo-default tabular-nums">{number}</span>{' '}
      {noun}
    </Text>
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
