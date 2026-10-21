// The Firestore panel: the database to look at (every one the project
// declares or a client has written to), a filter, and the shape of the
// database as a tree. Root collections, the subcollections that live
// under their documents, and so on down, each with its live count. Only the
// path to where you are is open; everything else waits behind its caret or
// the filter. A root opens as a grid; a nested pattern opens as the
// collection group it names, so every order in every user is one click,
// without walking through a user first. The foot says what the open shape
// holds.
//
// The tree waits on the engine's first walk of a database, minutes on one
// of millions of documents. Meanwhile the root collections, which one
// `ListCollectionIds` answers at once, stand in for it, each with its own
// count, and say that the subcollections are still being found.

import { InputGroup, Text, Tooltip } from '@cloudflare/kumo'
import {
  CaretRightIcon,
  DatabaseIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { PanelToggle, SectionPanel } from '@/components/shell/section-panel'
import {
  type SchemaNode,
  filterSchema,
  isExpanded,
  patternOf,
  workbenchSchemaQuery,
  useSchemaTree,
} from '../schema'
import { collectionsQuery } from '../queries'
import { formatNumber } from '../value'
import { DatabasePicker } from './database-picker'
import { RootCount } from './root-count'
import { useWorkbench } from './workbench-context'

export function SchemaPanel() {
  const workbench = useWorkbench()
  const schema = useQuery(workbenchSchemaQuery(workbench))
  const rootIds = useQuery({
    ...collectionsQuery(workbench.ownerScope, ''),
    enabled: schema.isPending,
  })
  const expanded = useSchemaTree((state) => state.expanded)
  const collapsed = useSchemaTree((state) => state.collapsed)
  const filter = useSchemaTree((state) => state.filter)
  const toggleNode = useSchemaTree((state) => state.toggleNode)
  const reveal = useSchemaTree((state) => state.reveal)
  const setFilter = useSchemaTree((state) => state.setFilter)
  const current = patternOf(workbench.collectionPath)
  useEffect(() => reveal(current), [reveal, current])
  const kept = filterSchema(schema.data, filter)
  const roots = (schema.data?.collections ?? []).filter((root) => !kept || kept.has(root.pattern))

  return (
    <SectionPanel label="Schema">
      {/* The inset is the toolbar's, so the panel's toggle at the head of
          the first row is where the toolbar shows it once the panel is
          hidden. */}
      <div className="grid shrink-0 gap-1.5 border-b border-kumo-line px-3 py-2">
        <div className="flex items-center gap-1.5">
          <PanelToggle where="panel" />
          <DatabasePicker
            value={workbench.database}
            onChange={workbench.setDatabase}
            className="flex-1"
          />
        </div>
        <InputGroup size="sm">
          <InputGroup.Addon>
            <MagnifyingGlassIcon size={14} />
          </InputGroup.Addon>
          <InputGroup.Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setFilter('')
                event.currentTarget.blur()
              }
            }}
            placeholder="Filter collections"
            aria-label="Filter collections"
            spellCheck={false}
            autoComplete="off"
            data-testid="schema-filter"
          />
          {filter && (
            <InputGroup.Addon align="end">
              <InputGroup.Button
                variant="ghost"
                shape="square"
                icon={<XIcon />}
                aria-label="Clear the filter"
                onClick={() => setFilter('')}
              />
            </InputGroup.Addon>
          )}
        </InputGroup>
      </div>
      <div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1.5"
        data-testid="schema-tree"
      >
        {schema.isPending && !(rootIds.data && rootIds.data.length > 0) && (
          <div className="animate-pulse px-1.5 py-2" data-testid="schema-mapping">
            <Text variant="secondary" size="sm">
              Mapping the database…
            </Text>
          </div>
        )}
        {schema.isPending && rootIds.data && rootIds.data.length > 0 && (
          <ul
            role="tree"
            aria-label="Collections"
            className="grid grid-cols-[minmax(0,1fr)] gap-px"
            data-testid="schema-roots-only"
          >
            {rootIds.data
              .filter((id) => id.toLowerCase().includes(filter.trim().toLowerCase()))
              .map((id) => (
                <RootOnlyNode
                  key={id}
                  id={id}
                  current={current === id}
                  onOpen={() => workbench.setPath(id)}
                />
              ))}
          </ul>
        )}
        {/* Last, and held at the panel's foot while the list scrolls: when the
            tree arrives and it goes, no row above it moves. */}
        {schema.isPending && rootIds.data && rootIds.data.length > 0 && (
          <div
            className="sticky -bottom-1.5 -mx-1.5 -mb-1.5 flex h-[42px] items-center border-t border-kumo-line bg-kumo-base px-3"
            data-testid="schema-mapping"
          >
            {/* The sidebar's footer is 42 px tall, so the two feet line up.
                Steady, not pulsing: at a pulse's faintest the secondary grey
                was too pale to read. */}
            <Text variant="secondary" size="sm">
              Finding subcollections…
            </Text>
          </div>
        )}
        {schema.isError && (
          <div className="px-1.5 py-2">
            <Text variant="secondary" size="sm">
              {schema.error.message}
            </Text>
          </div>
        )}
        {schema.data && schema.data.collections.length === 0 && (
          <div className="px-1.5 py-2">
            <Text variant="secondary" size="sm">
              No collections yet.
            </Text>
          </div>
        )}
        {schema.data && schema.data.collections.length > 0 && roots.length === 0 && (
          <div className="px-1.5 py-2">
            <Text variant="secondary" size="sm">
              No collection is named like that.
            </Text>
          </div>
        )}
        {roots.length > 0 && (
          <ul
            role="tree"
            aria-label="Collections"
            className="grid grid-cols-[minmax(0,1fr)] gap-px"
          >
            {roots.map((root) => (
              <TreeNode
                key={root.pattern}
                node={root}
                depth={0}
                current={current}
                kept={kept}
                open={(pattern) =>
                  isExpanded({ expanded, collapsed }, pattern, current, kept !== undefined)
                }
                onToggle={toggleNode}
                onOpen={(target) => workbench.setPath(target.pattern)}
              />
            ))}
          </ul>
        )}
      </div>
      {/* No footer. It said the current pattern, its document count and
          its parents, and the other patterns sharing its id: the first is
          the lit row and the path bar, the next two are that row's own
          count and tooltip, and the last is in the scope picker's menu,
          where "All" is chosen. It stacked a third band at the foot of the
          window beside the grid's footer and the Requests bar, and its
          count, a pattern's, disagreed with the filter line's whenever the
          grid showed one collection of it. */}
    </SectionPanel>
  )
}

function TreeNode({
  node,
  depth,
  current,
  kept,
  open,
  onToggle,
  onOpen,
}: {
  node: SchemaNode
  depth: number
  current: string
  kept: Set<string> | undefined
  open: (pattern: string) => boolean
  onToggle: (pattern: string, open: boolean) => void
  onOpen: (node: SchemaNode) => void
}) {
  const isCurrent = node.pattern === current
  const onPath = current === node.pattern || current.startsWith(`${node.pattern}/*/`)
  const children = node.children.filter((child) => !kept || kept.has(child.pattern))
  const expanded = children.length > 0 && open(node.pattern)
  // Where you are scrolls into view with what is open beneath it.
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (isCurrent) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [isCurrent])
  const parents =
    node.parents === null
      ? ''
      : ` in ${formatNumber(node.parents)} ${node.parents === 1 ? 'parent' : 'parents'}`
  return (
    <li
      ref={ref}
      role="treeitem"
      className="min-w-0"
      aria-expanded={children.length > 0 ? expanded : undefined}
    >
      <div
        className={`group flex h-7 items-center rounded-md pr-1.5 ${
          isCurrent
            ? 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-firenook-flame)]'
            : 'hover:ink'
        }`}
        data-testid="schema-node"
        data-pattern={node.pattern}
        aria-current={isCurrent ? 'location' : undefined}
      >
        {Array.from({ length: depth }, (_, level) => (
          <span key={level} className="relative h-full w-[14px] shrink-0">
            <span className="absolute top-0 bottom-0 left-[9px] border-l border-kumo-hairline" />
          </span>
        ))}
        {children.length > 0 ? (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-kumo-subtle hover:ink hover:text-kumo-default"
            onClick={() => onToggle(node.pattern, expanded)}
            aria-label={expanded ? `Collapse ${node.id}` : `Expand ${node.id}`}
            data-testid="schema-node-toggle"
          >
            <CaretRightIcon
              size={11}
              weight="bold"
              className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <Tooltip
          content={`${node.pattern} · ${formatNumber(node.documents)} ${
            node.documents === 1 ? 'document' : 'documents'
          }${parents}${
            !expanded && node.children.length > 0
              ? ` · ${node.children.length} ${
                  node.children.length === 1 ? 'subcollection' : 'subcollections'
                } below`
              : ''
          }`}
          render={
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-0.5 text-left"
              onClick={() => onOpen(node)}
              data-testid="schema-node-open"
            >
              {depth === 0 ? (
                <DatabaseIcon
                  size={13}
                  className={onPath ? 'shrink-0 text-kumo-default' : 'shrink-0 text-kumo-subtle'}
                />
              ) : (
                <FolderIcon
                  size={13}
                  className={onPath ? 'shrink-0 text-kumo-default' : 'shrink-0 text-kumo-subtle'}
                />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-kumo-default">
                {node.id}
              </span>
              {!expanded && node.children.length > 0 && (
                <span className="shrink-0 font-mono text-[10px] text-kumo-inactive tabular-nums">
                  +{node.children.length}
                </span>
              )}
              <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
                {formatNumber(node.documents)}
              </span>
            </button>
          }
        />
      </div>
      {expanded && (
        <ul role="group" className="grid grid-cols-[minmax(0,1fr)] gap-px">
          {children.map((child) => (
            <TreeNode
              key={child.pattern}
              node={child}
              depth={depth + 1}
              current={current}
              kept={kept}
              open={open}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * A root collection before the tree is known: no caret, since what lies
 * below is still being found, and its own count. Drawn like a root of the
 * tree, so nothing moves when the tree arrives.
 */
function RootOnlyNode({
  id,
  current,
  onOpen,
}: {
  id: string
  current: boolean
  onOpen: () => void
}) {
  return (
    <li role="treeitem" className="min-w-0">
      <div
        className={`group flex h-7 items-center rounded-md pr-1.5 ${
          current ? 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-firenook-flame)]' : 'hover:ink'
        }`}
        data-testid="schema-node"
        data-pattern={id}
        aria-current={current ? 'location' : undefined}
      >
        <span className="size-5 shrink-0" />
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-0.5 text-left"
          onClick={onOpen}
          data-testid="schema-node-open"
        >
          <DatabaseIcon
            size={13}
            className={current ? 'shrink-0 text-kumo-default' : 'shrink-0 text-kumo-subtle'}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-kumo-default">
            {id}
          </span>
          <RootCount path={id} />
        </button>
      </div>
    </li>
  )
}

/** What the open shape holds, or the database as a whole at the root. */
