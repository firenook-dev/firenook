// The Firestore panel: the database to look at (every one the project
// declares or a client has written to), a filter, and the shape of the
// database as a tree. Root collections, the subcollections that live
// under their documents, and so on down, each with its live count. Only the
// path to where you are is open; everything else waits behind its caret or
// the filter. A root opens as a grid; a nested pattern opens as the
// collection group it names, so every order in every user is one click,
// without walking through a user first. The foot says what the open shape
// holds.

import { InputGroup, Select, Text } from '@cloudflare/kumo'
import {
  CaretRightIcon,
  DatabaseIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { SectionPanel } from '@/components/shell/section-panel'
import { databaseItems, databasesQuery } from '../databases'
import {
  type SchemaNode,
  type SchemaSnapshot,
  filterSchema,
  findNode,
  isExpanded,
  patternOf,
  schemaQuery,
  siblingsById,
  useSchemaTree,
} from '../schema'
import { formatNumber } from '../value'
import { DEFAULT_DATABASE, useWorkbench } from './workbench-context'

export function SchemaPanel() {
  const workbench = useWorkbench()
  const schema = useQuery(schemaQuery(workbench.database))
  const expanded = useSchemaTree((state) => state.expanded)
  const collapsed = useSchemaTree((state) => state.collapsed)
  const filter = useSchemaTree((state) => state.filter)
  const toggleNode = useSchemaTree((state) => state.toggleNode)
  const reveal = useSchemaTree((state) => state.reveal)
  const setFilter = useSchemaTree((state) => state.setFilter)
  const current = patternOf(workbench.collectionPath)
  useEffect(() => reveal(current), [reveal, current])
  const kept = filterSchema(schema.data, filter)
  const node = findNode(schema.data, current)
  const roots = (schema.data?.collections ?? []).filter((root) => !kept || kept.has(root.pattern))
  const databases = useQuery(databasesQuery)

  return (
    <SectionPanel label="Schema">
      <div className="grid shrink-0 gap-1.5 border-b border-kumo-line p-2">
        <div data-testid="database-select">
          <Select
            size="sm"
            value={workbench.database}
            onValueChange={(value) => workbench.setDatabase(String(value))}
            // Opening the picker asks again, so a database a client created
            // since the panel mounted is in the list.
            onOpenChange={(open) => {
              if (open) void databases.refetch()
            }}
            items={databaseItems(databases.data, workbench.database, DEFAULT_DATABASE)}
            aria-label="Database"
            className="w-full font-mono"
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
                size="xs"
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
        {schema.isPending && (
          <div className="animate-pulse px-1.5 py-2">
            <Text variant="secondary" size="sm">
              Mapping the database…
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
      <Summary schema={schema.data} node={node} />
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
            ? 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-kumo-brand)]'
            : 'hover:bg-kumo-tint'
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
            className="flex size-5 shrink-0 items-center justify-center rounded text-kumo-subtle hover:bg-kumo-elevated hover:text-kumo-default"
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
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-0.5 text-left"
          onClick={() => onOpen(node)}
          data-testid="schema-node-open"
          title={`${node.pattern} · ${formatNumber(node.documents)} ${
            node.documents === 1 ? 'document' : 'documents'
          }${parents}`}
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
            <span
              className="shrink-0 font-mono text-[10px] text-kumo-inactive tabular-nums"
              title={`${node.children.length} ${
                node.children.length === 1 ? 'subcollection' : 'subcollections'
              } below`}
            >
              +{node.children.length}
            </span>
          )}
          <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
            {formatNumber(node.documents)}
          </span>
        </button>
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

/** What the open shape holds, or the database as a whole at the root. */
function Summary({
  schema,
  node,
}: {
  schema: SchemaSnapshot | undefined
  node: SchemaNode | undefined
}) {
  if (!schema) return null
  if (!node) {
    const roots = schema.collections.length
    return (
      <footer
        className="shrink-0 border-t border-kumo-line px-3 py-1.5"
        data-testid="schema-summary"
      >
        <span className="text-[12px] text-kumo-subtle tabular-nums">
          {formatNumber(roots)} root {roots === 1 ? 'collection' : 'collections'} ·{' '}
          {formatNumber(schema.documents)} {schema.documents === 1 ? 'document' : 'documents'}
        </span>
      </footer>
    )
  }
  const pattern = node.pattern
  const parentPattern = pattern.includes('/*/') ? pattern.slice(0, pattern.lastIndexOf('/*/')) : ''
  const parent = parentPattern ? findNode(schema, parentPattern) : undefined
  const siblings = siblingsById(schema, node)
  return (
    <footer
      className="grid shrink-0 gap-0.5 border-t border-kumo-line px-3 py-1.5"
      data-testid="schema-summary"
    >
      <span className="truncate font-mono text-[11px] text-kumo-subtle" title={pattern}>
        {pattern}
      </span>
      <span className="text-[12px] text-kumo-default tabular-nums">
        {formatNumber(node.documents)} {node.documents === 1 ? 'document' : 'documents'}
        {node.parents !== null && parent && (
          <span className="text-kumo-subtle">
            {' '}
            in {formatNumber(node.parents)} of {formatNumber(parent.documents)}{' '}
            <span className="font-mono text-[11px]">{parent.id}</span>
          </span>
        )}
      </span>
      {siblings.length > 0 && (
        <span className="text-[12px] text-kumo-subtle">
          The group also covers{' '}
          {siblings.map((sibling, index) => (
            <span key={sibling.pattern}>
              {index > 0 && ', '}
              <span className="font-mono text-[11px]">{sibling.pattern}</span>
            </span>
          ))}
        </span>
      )}
    </footer>
  )
}
