// The schema rail: the shape of the database as a tree, beside the grid.
// Root collections, the subcollections that live under their documents,
// and so on down, each with its live count. A root opens as a grid; a
// nested pattern opens as the collection group it names, so every order in
// every user is one click, without walking through a user first. The row
// for where you are is marked, and the footer says what that shape holds.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import {
  CaretRightIcon,
  DatabaseIcon,
  FolderIcon,
  SidebarSimpleIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { formatNumber } from '../value'
import {
  type SchemaNode,
  type SchemaSnapshot,
  findNode,
  patternOf,
  schemaQuery,
  siblingsById,
  useSchemaRail,
} from '../schema'
import { useWorkbench } from './workbench-context'

/** The rail's width plus the gap after it, px. */
export const SCHEMA_RAIL_WIDTH = 264 + 12

export function SchemaRail() {
  const workbench = useWorkbench()
  const schema = useQuery(schemaQuery(workbench.database))
  const collapsed = useSchemaRail((state) => state.collapsed)
  const toggleNode = useSchemaRail((state) => state.toggleNode)
  const close = useSchemaRail((state) => state.setOpen)
  const current = patternOf(workbench.collectionPath)
  const node = findNode(schema.data, current)

  return (
    <aside
      className="flex min-h-0 w-[264px] shrink-0 flex-col rounded-lg bg-kumo-base ring ring-kumo-line"
      data-testid="schema-rail"
      aria-label="Schema"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-line pr-1 pl-3">
        <TreeStructureIcon size={16} className="text-kumo-subtle" />
        <span className="text-sm font-semibold text-kumo-default">Schema</span>
        {schema.data && (
          <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
            {formatNumber(schema.data.documents)} docs
          </span>
        )}
        <span className="ml-auto">
          <Tooltip
            content="Hide the schema (t)"
            render={
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<SidebarSimpleIcon />}
                aria-label="Hide the schema"
                onClick={() => close(false)}
                data-testid="schema-rail-hide"
              />
            }
          />
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
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
        {schema.data && schema.data.collections.length > 0 && (
          <ul role="tree" aria-label="Collections" className="grid gap-px">
            {schema.data.collections.map((root) => (
              <TreeNode
                key={root.pattern}
                node={root}
                depth={0}
                current={current}
                collapsed={collapsed}
                onToggle={toggleNode}
                onOpen={(target) => workbench.setPath(target.pattern)}
              />
            ))}
          </ul>
        )}
      </div>
      <Summary schema={schema.data} node={node} pattern={current} />
    </aside>
  )
}

function TreeNode({
  node,
  depth,
  current,
  collapsed,
  onToggle,
  onOpen,
}: {
  node: SchemaNode
  depth: number
  current: string
  collapsed: Set<string>
  onToggle: (pattern: string) => void
  onOpen: (node: SchemaNode) => void
}) {
  const isCurrent = node.pattern === current
  const onPath = current === node.pattern || current.startsWith(`${node.pattern}/*/`)
  const expanded = node.children.length > 0 && !collapsed.has(node.pattern)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (isCurrent) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [isCurrent])
  const parents =
    node.parents === null
      ? ''
      : ` in ${formatNumber(node.parents)} ${node.parents === 1 ? 'parent' : 'parents'}`
  return (
    <li role="treeitem" aria-expanded={node.children.length > 0 ? expanded : undefined}>
      <div
        ref={ref}
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
        {node.children.length > 0 ? (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded text-kumo-subtle hover:bg-kumo-elevated hover:text-kumo-default"
            onClick={() => onToggle(node.pattern)}
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
          <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
            {formatNumber(node.documents)}
          </span>
        </button>
      </div>
      {expanded && (
        <ul role="group" className="grid gap-px">
          {node.children.map((child) => (
            <TreeNode
              key={child.pattern}
              node={child}
              depth={depth + 1}
              current={current}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/** What the current shape holds, or the database as a whole at the root. */
function Summary({
  schema,
  node,
  pattern,
}: {
  schema: SchemaSnapshot | undefined
  node: SchemaNode | undefined
  pattern: string
}) {
  if (!schema) return null
  if (!node) {
    const roots = schema.collections.length
    return (
      <footer className="shrink-0 border-t border-kumo-line px-3 py-2" data-testid="schema-summary">
        <Text variant="secondary" size="sm" as="p">
          {formatNumber(roots)} root {roots === 1 ? 'collection' : 'collections'} ·{' '}
          {formatNumber(schema.documents)} {schema.documents === 1 ? 'document' : 'documents'}
        </Text>
      </footer>
    )
  }
  const parentPattern = pattern.includes('/*/') ? pattern.slice(0, pattern.lastIndexOf('/*/')) : ''
  const parent = parentPattern ? findNode(schema, parentPattern) : undefined
  const siblings = siblingsById(schema, node)
  return (
    <footer
      className="grid shrink-0 gap-0.5 border-t border-kumo-line px-3 py-2"
      data-testid="schema-summary"
    >
      <span className="truncate font-mono text-[11px] text-kumo-subtle" title={node.pattern}>
        {node.pattern}
      </span>
      <span className="text-[13px] text-kumo-default tabular-nums">
        {formatNumber(node.documents)} {node.documents === 1 ? 'document' : 'documents'}
        {node.parents !== null && parent && (
          <span className="text-kumo-subtle">
            {' '}
            in {formatNumber(node.parents)} of {formatNumber(parent.documents)}{' '}
            <span className="font-mono text-[12px]">{parent.id}</span>
          </span>
        )}
      </span>
      {node.children.length > 0 && (
        <span className="text-[12px] text-kumo-subtle">
          Each holds{' '}
          {node.children.map((child, index) => (
            <span key={child.pattern}>
              {index > 0 && ', '}
              <span className="font-mono text-[11px] text-kumo-default">{child.id}</span>
            </span>
          ))}
        </span>
      )}
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
