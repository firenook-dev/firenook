// The shape of a database: the tree of collection patterns the engine
// keeps live (`users/*/orders/*/items`), with document counts and how many
// parents carry each subcollection. One request draws the whole tree,
// whatever the size of the database; the live channel refreshes it on
// every create or delete.

import { queryOptions } from '@tanstack/react-query'
import { create } from 'zustand'
import { API_BASE, ApiError } from '@/api/client'
import type { SchemaNode } from '@/api/generated/SchemaNode'
import type { SchemaSnapshot } from '@/api/generated/SchemaSnapshot'
import { FS } from './queries'

export type { SchemaNode, SchemaSnapshot }

export const schemaQuery = (database: string) =>
  queryOptions({
    queryKey: [FS, database, 'schema'],
    queryFn: async () => {
      const response = await fetch(
        `${API_BASE}/firestore/schema?database=${encodeURIComponent(database)}`,
        { headers: { accept: 'application/json' } },
      )
      if (!response.ok)
        throw new ApiError(response.status, `${response.status} ${response.statusText}`)
      return (await response.json()) as SchemaSnapshot
    },
    staleTime: 30_000,
    retry: false,
  })

/**
 * The pattern a path belongs to: document ids become `*`, and a document
 * path resolves to its collection. `users/u1/orders` and `users/u1/orders/o1`
 * both give `users/*\/orders`; a pattern is its own pattern.
 */
export function patternOf(path: string): string {
  const segments = path.split('/').filter(Boolean)
  if (segments.length % 2 === 0) segments.pop()
  return segments.map((segment, index) => (index % 2 === 1 ? '*' : segment)).join('/')
}

/** Whether a path in the URL is a pattern rather than a concrete collection. */
export function isPattern(path: string): boolean {
  return path.split('/').includes('*')
}

/** The node for `pattern`, or undefined when the tree has no such shape. */
export function findNode(
  schema: SchemaSnapshot | undefined,
  pattern: string,
): SchemaNode | undefined {
  if (!schema || !pattern) return undefined
  const ids = pattern.split('/*/')
  let level = schema.collections
  let node: SchemaNode | undefined
  for (const id of ids) {
    node = level.find((candidate) => candidate.id === id)
    if (!node) return undefined
    level = node.children
  }
  return node
}

/** The subcollection patterns known under a collection path or pattern. */
export function childrenOf(schema: SchemaSnapshot | undefined, path: string): SchemaNode[] {
  return findNode(schema, patternOf(path))?.children ?? []
}

/** Every node with its depth, roots first, children right after their parent. */
export function flattenSchema(
  schema: SchemaSnapshot | undefined,
): Array<{ node: SchemaNode; depth: number; parent: SchemaNode | undefined }> {
  const out: Array<{ node: SchemaNode; depth: number; parent: SchemaNode | undefined }> = []
  const visit = (node: SchemaNode, depth: number, parent: SchemaNode | undefined) => {
    out.push({ node, depth, parent })
    for (const child of node.children) visit(child, depth + 1, node)
  }
  for (const root of schema?.collections ?? []) visit(root, 0, undefined)
  return out
}

/** The other patterns that share a collection id with `node`, if any. */
export function siblingsById(schema: SchemaSnapshot | undefined, node: SchemaNode): SchemaNode[] {
  return flattenSchema(schema)
    .map((entry) => entry.node)
    .filter((candidate) => candidate.id === node.id && candidate.pattern !== node.pattern)
}

/** Formats a node's shape for one line: `orders › items · sessions`. */
export function describeChildren(node: SchemaNode, limit = 4): string {
  const parts = node.children.map((child) => {
    const deeper =
      child.children.length > 0 ? ` › ${child.children.map((c) => c.id).join(', ')}` : ''
    return `${child.id}${deeper}`
  })
  if (parts.length <= limit) return parts.join(' · ')
  return `${parts.slice(0, limit).join(' · ')} · +${parts.length - limit}`
}

const RAIL_KEY = 'firenook.console.firestore.schema-rail'

interface SchemaRailState {
  /** Whether the schema rail is on screen; remembered per browser. */
  open: boolean
  /** Patterns the person collapsed; everything else stays expanded. */
  collapsed: Set<string>
  setOpen: (open: boolean) => void
  toggle: () => void
  toggleNode: (pattern: string) => void
}

function loadOpen(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) !== 'closed'
  } catch {
    return true
  }
}

function saveOpen(open: boolean) {
  try {
    localStorage.setItem(RAIL_KEY, open ? 'open' : 'closed')
  } catch {
    // A browser that refuses storage simply starts open next time.
  }
}

export const useSchemaRail = create<SchemaRailState>((set) => ({
  open: loadOpen(),
  collapsed: new Set(),
  setOpen: (open) => {
    saveOpen(open)
    set({ open })
  },
  toggle: () =>
    set((state) => {
      saveOpen(!state.open)
      return { open: !state.open }
    }),
  toggleNode: (pattern) =>
    set((state) => {
      const collapsed = new Set(state.collapsed)
      if (collapsed.has(pattern)) collapsed.delete(pattern)
      else collapsed.add(pattern)
      return { collapsed }
    }),
}))
