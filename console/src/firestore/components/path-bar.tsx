// The path bar is the workbench's command line: type or paste any path and
// press Enter, click a segment to go up, see the live count of every
// collection on the way. `/` focuses it from anywhere on the page.

import { Button, Tooltip } from '@cloudflare/kumo'
import { CopyIcon, DatabaseIcon, FolderPlusIcon, StackIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useCreateDialog, validateId } from '../create'
import { EMPTY_QUERY } from '../query'
import { collectionsQuery, countQueryOptions } from '../queries'
import { formatNumber } from '../value'
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
      className="flex h-11 items-center gap-1 rounded-lg bg-kumo-base pr-2 pl-3 ring ring-kumo-line"
      data-testid="path-bar"
    >
      <span className="flex h-lh items-center text-kumo-subtle">
        <DatabaseIcon size={16} />
      </span>
      {editing === null ? (
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          <PathSegment label={workbench.database} onClick={() => workbench.setPath('')} first />
          {segments.map((segment, index) => {
            const path = segments.slice(0, index + 1).join('/')
            const isCollection = index % 2 === 0
            return (
              <PathSegment
                key={path}
                label={segment}
                current={index === segments.length - 1}
                onClick={() => workbench.setPath(path)}
                count={isCollection ? <CollectionCount path={path} /> : undefined}
              />
            )
          })}
          <button
            type="button"
            className="ml-1 h-7 min-w-24 flex-1 cursor-text rounded-md px-2 text-left font-mono text-[0.9em] text-kumo-inactive hover:bg-kumo-tint"
            onClick={() => setEditing(workbench.path)}
            aria-label="Edit the path"
          >
            {segments.length === 0 ? 'Type a collection or document path' : ''}
          </button>
        </div>
      ) : (
        <div className="relative min-w-0 flex-1">
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
            className="h-7 w-full rounded-md bg-kumo-control px-2 font-mono text-[0.9em] text-kumo-default outline-none ring ring-kumo-focus"
            placeholder="users/u_9f3k2/orders"
            spellCheck={false}
            autoComplete="off"
            aria-label="Path"
            data-testid="path-input"
          />
          {suggestions.data && (matching(suggestions.data, editing).length > 0 || creatable) && (
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
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {workbench.collectionPath && (
          <Tooltip
            content="Query every collection with this id, at any depth"
            render={
              <Button
                variant={workbench.group ? 'primary' : 'ghost'}
                size="sm"
                icon={<StackIcon />}
                onClick={() => workbench.setGroup(!workbench.group)}
                aria-pressed={workbench.group}
                aria-label="Toggle collection group"
              >
                group
              </Button>
            }
          />
        )}
        <Tooltip
          content="Copy the path"
          render={
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CopyIcon />}
              aria-label="Copy the path"
              onClick={() =>
                void navigator.clipboard.writeText(workbench.selectedDocument ?? workbench.path)
              }
            />
          }
        />
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
  const count = useQuery(countQueryOptions(workbench.ownerScope, path, false, EMPTY_QUERY))
  if (count.data === undefined) return null
  return (
    <span className="text-[11px] text-kumo-subtle tabular-nums">
      {formatNumber(count.data.count)}
    </span>
  )
}
