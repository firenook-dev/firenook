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

/** The ancestors of a pattern, nearest last: `users/*\/orders/*\/items` → `users`, `users/*\/orders`. */
export function ancestorsOf(pattern: string): string[] {
  const ids = pattern.split('/*/')
  return ids.slice(0, -1).map((_, index) => ids.slice(0, index + 1).join('/*/'))
}

/**
 * The patterns a filter keeps: every node whose id contains the text, with
 * the ancestors that lead to it. Undefined when there is no filter, so the
 * tree shows everything.
 */
export function filterSchema(
  schema: SchemaSnapshot | undefined,
  text: string,
): Set<string> | undefined {
  const needle = text.trim().toLowerCase()
  if (!needle) return undefined
  const kept = new Set<string>()
  for (const { node } of flattenSchema(schema)) {
    if (!node.id.toLowerCase().includes(needle)) continue
    kept.add(node.pattern)
    for (const ancestor of ancestorsOf(node.pattern)) kept.add(ancestor)
  }
  return kept
}

interface SchemaTreeState {
  /** Patterns the person opened that would otherwise be closed. */
  expanded: Set<string>
  /** Patterns the person closed that would otherwise be open. */
  collapsed: Set<string>
  /** Text narrowing the tree to matching ids. */
  filter: string
  toggleNode: (pattern: string, open: boolean) => void
  /** Clears any explicit collapse along a path, so where you are is on screen. */
  reveal: (pattern: string) => void
  setFilter: (filter: string) => void
}

export const useSchemaTree = create<SchemaTreeState>((set) => ({
  expanded: new Set(),
  collapsed: new Set(),
  filter: '',
  toggleNode: (pattern, open) =>
    set((state) => {
      const expanded = new Set(state.expanded)
      const collapsed = new Set(state.collapsed)
      if (open) {
        expanded.delete(pattern)
        collapsed.add(pattern)
      } else {
        collapsed.delete(pattern)
        expanded.add(pattern)
      }
      return { expanded, collapsed }
    }),
  reveal: (pattern) =>
    set((state) => {
      const along = [...ancestorsOf(pattern), pattern]
      if (!along.some((ancestor) => state.collapsed.has(ancestor))) return state
      const collapsed = new Set(state.collapsed)
      for (const ancestor of along) collapsed.delete(ancestor)
      return { collapsed }
    }),
  setFilter: (filter) => set({ filter }),
}))

/**
 * Whether a node shows its children: open along the path to where you are,
 * open everywhere while a filter narrows the tree, otherwise as the person
 * left it, and closed until then.
 */
export function isExpanded(
  state: Pick<SchemaTreeState, 'expanded' | 'collapsed'>,
  pattern: string,
  current: string,
  filtering: boolean,
): boolean {
  if (filtering) return true
  if (state.collapsed.has(pattern)) return false
  if (state.expanded.has(pattern)) return true
  return current === pattern || current.startsWith(`${pattern}/*/`)
}
