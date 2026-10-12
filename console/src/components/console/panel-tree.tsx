// A section panel's tree: folders, functions by codebase, topics and their
// subscriptions, queues. Set like the Firestore schema tree (28 px rows,
// guide lines per depth, a 20 px caret, 13 px icons, 12 px names in the data
// face, `+N` children when shut, the count at the end) and always
// virtualized — one code path and one set of tests, and a three-row tree
// costs nothing extra.
//
// It is one ARIA tree with a roving focus: ↑ ↓ move, → opens or steps into
// the first child, ← shuts or steps out to the parent, Enter opens the node,
// ⌘C copies its id. The row itself takes the pointer: a click opens it, the
// caret toggles it.

import { Tooltip, cn } from '@cloudflare/kumo'
import { CaretRightIcon, type Icon } from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'

export interface PanelTreeNode {
  id: string
  label: string
  icon?: Icon | undefined
  count?: number | string | undefined
  /** The tooltip on the row: what it is and what it holds. */
  title?: string | undefined
  children?: readonly PanelTreeNode[] | undefined
  /** Applied to the count: a stalled backlog, failed deliveries, a codebase that failed to load. */
  tone?: 'warning' | 'danger' | undefined
}

/** One visible row of the tree. */
export interface TreeRow {
  node: PanelTreeNode
  depth: number
  parent: string | undefined
  /** Children the row can show (after the filter). */
  childCount: number
  open: boolean
  /** On the way to the current node, or the current node itself. */
  onPath: boolean
  /** 1-based position among its siblings, and how many there are, for assistive technology. */
  position: number
  siblings: number
}

/** The nodes a filter keeps: those that match and every ancestor of one that does. */
function keptByFilter(nodes: readonly PanelTreeNode[], filter: string): Set<string> {
  const needle = filter.trim().toLowerCase()
  const kept = new Set<string>()
  const visit = (node: PanelTreeNode): boolean => {
    let keep = node.label.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle)
    for (const child of node.children ?? []) if (visit(child)) keep = true
    if (keep) kept.add(node.id)
    return keep
  }
  for (const node of nodes) visit(node)
  return kept
}

/** The ids from a root down to `current`, inclusive; empty when it is not in the tree. */
function pathTo(nodes: readonly PanelTreeNode[], current: string | undefined): Set<string> {
  const path: string[] = []
  const find = (list: readonly PanelTreeNode[]): boolean => {
    for (const node of list) {
      path.push(node.id)
      if (node.id === current || find(node.children ?? [])) return true
      path.pop()
    }
    return false
  }
  if (current !== undefined) find(nodes)
  return new Set(path)
}

/**
 * The rows on screen, in order: every root, and the children of each open
 * node. While filtering, only matches and their ancestors, all open.
 */
export function visibleRows(
  nodes: readonly PanelTreeNode[],
  expanded: ReadonlySet<string>,
  filter: string | undefined,
  current: string | undefined,
): TreeRow[] {
  const filtering = Boolean(filter?.trim())
  const kept = filtering ? keptByFilter(nodes, filter ?? '') : undefined
  const onPath = pathTo(nodes, current)
  const rows: TreeRow[] = []
  const walk = (list: readonly PanelTreeNode[], depth: number, parent: string | undefined) => {
    const shown = kept ? list.filter((node) => kept.has(node.id)) : list
    shown.forEach((node, index) => {
      const children = (node.children ?? []).filter((child) => !kept || kept.has(child.id))
      const open = children.length > 0 && (filtering || expanded.has(node.id))
      rows.push({
        node,
        depth,
        parent,
        childCount: children.length,
        open,
        onPath: onPath.has(node.id),
        position: index + 1,
        siblings: shown.length,
      })
      if (open) walk(children, depth + 1, node.id)
    })
  }
  walk(nodes, 0, undefined)
  return rows
}

/** Each row is 28 px with a hairline gap under it, as the schema tree spaces them. */
const ROW_PITCH = 29

export function PanelTree({
  nodes,
  current,
  expanded,
  onToggle,
  onOpen,
  filter,
  ariaLabel,
  empty,
  testId,
}: {
  nodes: readonly PanelTreeNode[]
  /** The node the page shows: lit, with the accent bar, and scrolled into view. */
  current?: string | undefined
  expanded: ReadonlySet<string>
  onToggle: (id: string, open: boolean) => void
  onOpen: (node: PanelTreeNode) => void
  /** The panel filter's text: matches and their ancestors stay, all open. */
  filter?: string | undefined
  ariaLabel: string
  /** Said when the filter leaves nothing ("No queue is named like that."). */
  empty?: string | undefined
  testId?: string
}) {
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const rows = visibleRows(nodes, expanded, filter, current)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState<string | undefined>(undefined)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PITCH,
    getItemKey: (index) => rows[index]?.node.id ?? index,
    overscan: 10,
  })

  // Where you are scrolls into view with what is open beneath it.
  const currentIndex = rows.findIndex((row) => row.node.id === current)
  useEffect(() => {
    if (currentIndex !== -1) virtualizer.scrollToIndex(currentIndex, { align: 'auto' })
  }, [currentIndex, virtualizer])

  // The roving focus: the row last focused, else the current one, else the first.
  const focusId =
    (focused !== undefined && rows.some((row) => row.node.id === focused) ? focused : undefined) ??
    (currentIndex !== -1 ? current : rows[0]?.node.id)

  const focusRow = (index: number) => {
    const row = rows[index]
    if (!row) return
    setFocused(row.node.id)
    virtualizer.scrollToIndex(index, { align: 'auto' })
    // The row may only now be rendered; focus it once it is.
    requestAnimationFrame(() =>
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(row.node.id)}"]`)
        ?.focus(),
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.node.id === focusId)
    const row = rows[index]
    if (!row) return
    const mod = event.metaKey || event.ctrlKey
    switch (event.key) {
      case 'ArrowDown':
        focusRow(Math.min(rows.length - 1, index + 1))
        break
      case 'ArrowUp':
        focusRow(Math.max(0, index - 1))
        break
      case 'Home':
        focusRow(0)
        break
      case 'End':
        focusRow(rows.length - 1)
        break
      case 'ArrowRight':
        if (row.childCount === 0) return
        if (!row.open) onToggle(row.node.id, true)
        else focusRow(index + 1)
        break
      case 'ArrowLeft':
        if (row.open) onToggle(row.node.id, false)
        else if (row.parent !== undefined)
          focusRow(rows.findIndex((candidate) => candidate.node.id === row.parent))
        else return
        break
      case 'Enter':
      case ' ':
        onOpen(row.node)
        break
      case 'c':
      case 'C':
        if (!mod || window.getSelection()?.toString()) return
        void copyId(row.node.id)
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const items = virtualizer.getVirtualItems()
  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1.5"
      data-testid={testId}
    >
      {rows.length === 0 && filter?.trim() ? (
        <p className="px-1.5 py-2 text-[13px] text-kumo-subtle" data-testid="panel-tree-empty">
          {empty ?? 'Nothing is named like that.'}
        </p>
      ) : (
        <div
          role="tree"
          aria-label={ariaLabel}
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
          onKeyDown={onKeyDown}
        >
          {items.map((item) => {
            const row = rows[item.index]
            if (!row) return null
            return (
              <TreeRowView
                key={row.node.id}
                row={row}
                top={item.start}
                current={row.node.id === current}
                tabbable={row.node.id === focusId}
                onFocus={() => setFocused(row.node.id)}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    toast({ key: 'panel-tree-copy', title: `Copied ${id}` })
  } catch {
    toast({ key: 'panel-tree-copy', title: 'Could not copy', tone: 'danger' })
  }
}

function TreeRowView({
  row,
  top,
  current,
  tabbable,
  onFocus,
  onToggle,
  onOpen,
}: {
  row: TreeRow
  top: number
  current: boolean
  tabbable: boolean
  onFocus: () => void
  onToggle: (id: string, open: boolean) => void
  onOpen: (node: PanelTreeNode) => void
}) {
  const { node, depth, childCount, open, onPath } = row
  const Glyph = node.icon
  const count =
    node.count === undefined
      ? undefined
      : typeof node.count === 'number'
        ? formatNumber(node.count)
        : node.count
  const body = (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-setsize={row.siblings}
      aria-posinset={row.position}
      aria-expanded={childCount > 0 ? open : undefined}
      aria-current={current ? 'location' : undefined}
      aria-label={node.label}
      tabIndex={tabbable ? 0 : -1}
      data-node-id={node.id}
      data-testid="panel-tree-node"
      onFocus={onFocus}
      onClick={() => onOpen(node)}
      className={cn(
        'absolute inset-x-0 flex h-7 cursor-default items-center rounded-md pr-1.5 outline-none select-none focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:ring-inset',
        current ? 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-kumo-brand)]' : 'hover:ink',
      )}
      style={{ transform: `translateY(${top}px)` }}
    >
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} className="relative h-full w-[14px] shrink-0" aria-hidden>
          <span className="absolute top-0 bottom-0 left-[9px] border-l border-kumo-hairline" />
        </span>
      ))}
      {childCount > 0 ? (
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-kumo-subtle hover:ink hover:text-kumo-default"
          onClick={(event) => {
            event.stopPropagation()
            onToggle(node.id, !open)
          }}
          aria-hidden
          data-testid="panel-tree-toggle"
        >
          <CaretRightIcon
            size={11}
            weight="bold"
            className={cn('transition-transform', open && 'rotate-90')}
          />
        </span>
      ) : (
        <span className="size-5 shrink-0" aria-hidden />
      )}
      <span className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-0.5">
        {Glyph && (
          <Glyph
            size={13}
            className={cn('shrink-0', onPath ? 'text-kumo-default' : 'text-kumo-subtle')}
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-kumo-default">
          {node.label}
        </span>
        {!open && childCount > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-kumo-inactive tabular-nums">
            +{childCount}
          </span>
        )}
        {count !== undefined && (
          <span
            className={cn(
              'shrink-0 font-mono text-[11px] tabular-nums',
              node.tone === 'danger'
                ? 'text-kumo-danger'
                : node.tone === 'warning'
                  ? 'text-kumo-warning'
                  : 'text-kumo-subtle',
            )}
            data-tone={node.tone}
          >
            {count}
          </span>
        )}
      </span>
    </div>
  )
  return node.title ? <Tooltip content={node.title} render={body} /> : body
}
