// The path bar is the workbench's command line, the left half of the
// toolbar: type or paste any path and press Enter, click a segment to go
// up, see the live count of every collection on the way. `/` focuses it
// from anywhere on the page. What lives below is the panel's job.
//
// The path is a field at all times, the way an address bar is. Reading it
// and typing it are the same box, so clicking to edit changes the content
// and nothing else, and the one control that acts on the whole path — copy
// — sits inside that box against its right edge, where it is always at the
// end of the path without being dragged about by the path's length.

import { Button, Tooltip } from '@cloudflare/kumo'
import { CopyIcon, FolderPlusIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useCreateDialog, validateId } from '../create'
import { EMPTY_QUERY } from '../query'
import { collectionsQuery, countQueryOptions } from '../queries'
import { findNode, isPattern, schemaQuery } from '../schema'
import { formatNumber } from '../value'
import { ScopePicker } from './scope-picker'
import { useWorkbench } from './workbench-context'

export function PathBar() {
  const workbench = useWorkbench()
  const openCreate = useCreateDialog((state) => state.open)
  const [editing, setEditing] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        setEditing(workbench.path)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [workbench.path])

  useEffect(() => {
    if (editing !== null) inputRef.current?.select()
  }, [editing])

  // A path too long for its box scrolls to the end, not the start: the
  // database name never changes, and where you are is the last segment. Both
  // sides of that move — the counts arrive after the segments do and widen
  // them, and the window narrows and takes the box's width away — so watch
  // the content and the box rather than measuring once.
  const trail = useRef<HTMLDivElement>(null)
  const segmentsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = trail.current
    const content = segmentsRef.current
    if (!box || !content) return
    const toEnd = () => {
      box.scrollLeft = box.scrollWidth
    }
    toEnd()
    const observer = new ResizeObserver(toEnd)
    observer.observe(content)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  const segments = workbench.path ? workbench.path.split('/') : []
  const suggestions = useQuery({
    ...collectionsQuery(workbench.ownerScope, parentDocumentOf(editing ?? '')),
    enabled: editing !== null,
  })

  function commit(value: string) {
    setEditing(null)
    workbench.setPath(value)
  }

  // A collection segment that matches nothing can be created on the spot.
  const creatable = editing !== null ? creatableCollection(suggestions.data, editing) : undefined
  function create() {
    if (!creatable) return
    setEditing(null)
    openCreate({ kind: 'collection', parent: creatable.parent, id: creatable.id })
  }

  return (
    <div
      // The clip is what stops the controls, which never shrink, from
      // painting over the status group when the row runs out of room. It has
      // to lift while the completions are open, because they hang below the
      // row from inside it and a clipped popup is an invisible one.
      className={`flex h-full min-w-0 flex-1 items-center gap-1 ${
        editing === null ? 'overflow-hidden' : ''
      }`}
      data-testid="path-bar"
    >
      {/* The scope leads the row and keeps a fixed place: a path changes
          length with every move, and a control placed after it can never be
          aimed at twice. */}
      {workbench.collectionPath && (
        <div className="mr-1 flex shrink-0 items-center" data-testid="path-controls">
          <ScopePicker />
        </div>
      )}
      <div
        className={`relative flex h-8 min-w-0 flex-1 items-center rounded-lg pr-0.5 pl-1 ring ${
          editing === null ? 'ring-kumo-hairline' : 'bg-kumo-control ring-kumo-focus'
        }`}
        data-testid="path-field"
      >
        {editing === null ? (
          <>
            {/* The segments scroll inside a box of their own, so a long path
                never pushes anything else along the row. */}
            <div
              ref={trail}
              className="flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              data-testid="path-segments"
            >
              <div ref={segmentsRef} className="flex items-center">
                <PathSegment
                  label={workbench.database}
                  onClick={() => workbench.setPath('')}
                  first
                />
                {segments.map((segment, index) => {
                  const path = segments.slice(0, index + 1).join('/')
                  const isCollection = index % 2 === 0
                  // The `*` of a pattern stands for any document; it goes nowhere.
                  if (segment === '*')
                    return (
                      <span key={path} className="flex shrink-0 items-center">
                        <span className="px-0.5 text-kumo-inactive">/</span>
                        <span
                          className="px-1.5 font-mono text-[0.9em] text-kumo-inactive"
                          title="Any document"
                        >
                          *
                        </span>
                      </span>
                    )
                  return (
                    <PathSegment
                      key={path}
                      label={segment}
                      current={index === segments.length - 1}
                      onClick={() => workbench.setPath(path)}
                      // The query line already counts the collection in view, under
                      // the query and the identity actually in force. A second
                      // figure here can only agree redundantly or disagree silently.
                      count={
                        isCollection && path !== workbench.collectionPath ? (
                          <CollectionCount path={path} />
                        ) : undefined
                      }
                    />
                  )
                })}
              </div>
            </div>
            <button
              type="button"
              className="h-7 flex-1 basis-0 cursor-text rounded-md px-1.5 text-left text-[0.9em] text-kumo-inactive"
              onClick={() => setEditing(workbench.path)}
              aria-label="Edit the path"
              // Empty space to click: it gives up every pixel the path itself
              // needs before the path starts scrolling.
            >
              {segments.length === 0 ? 'Type a collection or document path' : ''}
            </button>
          </>
        ) : (
          <input
            ref={inputRef}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && creatable) {
                event.preventDefault()
                create()
              } else if (event.key === 'Enter') {
                event.preventDefault()
                commit(editing)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(null)
              } else if (event.key === 'Tab') {
                const first = matching(suggestions.data, editing)[0]
                if (first) {
                  event.preventDefault()
                  setEditing(
                    `${parentDocumentOf(editing)}${parentDocumentOf(editing) ? '/' : ''}${first}/`,
                  )
                }
              }
            }}
            onBlur={() =>
              window.setTimeout(
                () => setEditing((current) => (current === editing ? null : current)),
                120,
              )
            }
            className="h-full min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[0.9em] text-kumo-default outline-none"
            placeholder="users/u_9f3k2/orders"
            spellCheck={false}
            autoComplete="off"
            aria-label="Path"
            data-testid="path-input"
          />
        )}
        {/* Inside the field and against its right edge: the end of the path
            wherever the path ends, and a target that never moves. */}
        <Tooltip
          content="Copy the path"
          render={
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CopyIcon />}
              aria-label="Copy the path"
              className="h-7 w-7 shrink-0"
              onClick={() =>
                void navigator.clipboard.writeText(
                  editing ?? workbench.selectedDocument ?? workbench.path,
                )
              }
            />
          }
        />
        {editing !== null &&
          suggestions.data &&
          (matching(suggestions.data, editing).length > 0 || creatable) && (
            <ul className="absolute top-full left-0 z-20 mt-1 max-h-64 w-max min-w-80 max-w-[40rem] overflow-auto rounded-lg bg-kumo-elevated p-1 shadow-md ring ring-kumo-line">
              {creatable && (
                <li>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[0.9em] hover:bg-kumo-tint"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={create}
                    data-testid="path-create-collection"
                  >
                    <FolderPlusIcon size={14} className="shrink-0 text-kumo-subtle" />
                    <span className="min-w-0 flex-1 truncate">
                      Create collection{' '}
                      <span className="font-mono">
                        {creatable.parent ? `${creatable.parent}/` : ''}
                        {creatable.id}
                      </span>
                    </span>
                    <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px] text-kumo-subtle">
                      ⌘↵
                    </kbd>
                  </button>
                </li>
              )}
              {matching(suggestions.data, editing).map((id) => {
                const parent = parentDocumentOf(editing)
                const full = parent ? `${parent}/${id}` : id
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[0.9em] hover:bg-kumo-tint"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => commit(full)}
                    >
                      {full}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    </div>
  )
}

/** For `users/u1/ord` → `users/u1`; for `ord` → ``. Suggestions list the collections under it. */
function parentDocumentOf(typed: string): string {
  const segments = typed.replace(/^\/+/, '').split('/')
  segments.pop()
  return segments.length % 2 === 0 ? segments.join('/') : segments.slice(0, -1).join('/')
}

/** The collection the typed path would create, when its last segment exists nowhere yet. */
function creatableCollection(
  ids: string[] | undefined,
  typed: string,
): { parent: string; id: string } | undefined {
  if (!ids) return undefined
  const segments = typed.replace(/^\/+/, '').split('/')
  if (segments.length % 2 === 0) return undefined
  const id = segments.at(-1) ?? ''
  if (validateId(id, 'collection') || ids.includes(id)) return undefined
  return { parent: parentDocumentOf(typed), id }
}

function matching(ids: string[] | undefined, typed: string): string[] {
  if (!ids) return []
  const last = typed.split('/').at(-1)?.toLowerCase() ?? ''
  const segments = typed.replace(/^\/+/, '').split('/')
  // Only complete collection segments (odd positions).
  if (segments.length % 2 === 0) return []
  return ids.filter((id) => id.toLowerCase().startsWith(last)).slice(0, 12)
}

function PathSegment({
  label,
  onClick,
  count,
  current,
  first,
}: {
  label: string
  onClick: () => void
  count?: React.ReactNode
  current?: boolean
  first?: boolean
}) {
  return (
    <span className="flex shrink-0 items-center">
      {!first && <span className="px-0.5 text-kumo-inactive">/</span>}
      <button
        type="button"
        onClick={onClick}
        className={`flex h-7 items-center gap-1.5 rounded-md px-1.5 font-mono text-[0.9em] hover:bg-kumo-tint ${
          current ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-default'
        }`}
        aria-current={current ? 'location' : undefined}
      >
        {label}
        {count}
      </button>
    </span>
  )
}

function CollectionCount({ path }: { path: string }) {
  const workbench = useWorkbench()
  const pattern = isPattern(path)
  // A concrete collection is counted from the index; a pattern's count is
  // what the schema tree keeps for it.
  const count = useQuery({
    ...countQueryOptions(workbench.ownerScope, path, false, EMPTY_QUERY),
    enabled: !pattern,
  })
  const schema = useQuery({ ...schemaQuery(workbench.database), enabled: pattern })
  const value = pattern ? findNode(schema.data, path)?.documents : count.data?.count
  if (value === undefined) return null
  return <span className="text-[11px] text-kumo-subtle tabular-nums">{formatNumber(value)}</span>
}
