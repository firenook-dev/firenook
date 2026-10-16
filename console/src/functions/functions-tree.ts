// The Functions panel's tree, built from the snapshot: "All functions",
// then each codebase — the project's own first, extension instances after —
// with its functions under it, and the functions the manifest declares but
// the emulator dropped at load listed where they would have been. Pure, so
// the page and the Invocations page build the same tree and a test can
// hold its shape.
//
// The count slot says what a row has to say: a function count for a
// codebase that loaded, "Failed" or "Discovering… 1.4 s" for one that did
// not (yet), and for a function only a problem — ignored, no service,
// paused, removed, not loaded — or that it is running now. A healthy
// function says nothing.

import { FolderSimpleIcon, ListIcon, ProhibitIcon, PuzzlePieceIcon } from '@phosphor-icons/react'
import type { FunctionCodebaseEntry } from '@/api/generated/compute/FunctionCodebaseEntry'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import type { PanelTreeNode } from '@/components/console/panel-tree'
import { formatDuration, formatNumber } from '@/lib/format'
import { KIND_ICON } from './kinds'
import { notLoadedText, statusText, triggerText } from './trigger-text'

/** The tree's root row: every function. */
export const ALL_NODE = 'all'

/** What a node opens. */
export type TreeTarget =
  | { kind: 'all' }
  | { kind: 'codebase'; codebase: string }
  | { kind: 'function'; id: string }
  | { kind: 'notLoaded'; codebase: string; id: string }

export const codebaseNode = (codebase: string) => `codebase:${codebase}`
export const functionNode = (id: string) => `function:${id}`
const notLoadedNode = (codebase: string, id: string) => `not-loaded:${codebase}:${id}`

/** The node id's target. */
export function nodeTarget(id: string): TreeTarget {
  if (id.startsWith('codebase:'))
    return { kind: 'codebase', codebase: id.slice('codebase:'.length) }
  if (id.startsWith('function:')) return { kind: 'function', id: id.slice('function:'.length) }
  if (id.startsWith('not-loaded:')) {
    const rest = id.slice('not-loaded:'.length)
    const at = rest.indexOf(':')
    return { kind: 'notLoaded', codebase: rest.slice(0, at), id: rest.slice(at + 1) }
  }
  return { kind: 'all' }
}

/** User codebases first, then extension instances, each in the engine's order. */
export function orderedCodebases(
  codebases: readonly FunctionCodebaseEntry[],
): FunctionCodebaseEntry[] {
  return [
    ...codebases.filter((entry) => entry.codebase.kind === 'user'),
    ...codebases.filter((entry) => entry.codebase.kind === 'extension'),
  ]
}

/** "Discovering… 1.4 s" for a codebase that is loading, from when it started. */
export function discoveringText(loadingSince: string | null, now: number): string {
  if (!loadingSince) return 'Discovering…'
  const since = Date.parse(loadingSince)
  if (Number.isNaN(since)) return 'Discovering…'
  return `Discovering… ${formatDuration(Math.max(0, now - since))}`
}

/** A function row's mark: a problem, or that it runs now; nothing when all is well. */
export function functionMark(summary: FunctionSummary): {
  count?: string
  tone?: 'warning' | 'danger'
} {
  switch (summary.status) {
    case 'ignored':
      return { count: 'ignored', tone: 'warning' }
    case 'noService':
      return { count: 'no service', tone: 'warning' }
    case 'paused':
      return { count: 'paused', tone: 'warning' }
    case 'removed':
      return { count: 'removed' }
    case 'receiving':
      return summary.stats.inFlight > 0
        ? { count: `${formatNumber(summary.stats.inFlight)} running` }
        : {}
  }
}

function functionTitle(summary: FunctionSummary): string {
  const lines = [`${summary.kind} · ${summary.region}`]
  const trigger = triggerText(summary)
  if (trigger) lines.push(trigger)
  if (summary.status !== 'receiving') lines.push(statusText(summary))
  return lines.join(' — ')
}

/** A function's row in the tree. */
function functionRow(summary: FunctionSummary): PanelTreeNode {
  const mark = functionMark(summary)
  return {
    id: functionNode(summary.id),
    label: summary.name,
    icon: KIND_ICON[summary.kind],
    title: functionTitle(summary),
    count: mark.count,
    tone: mark.tone,
  }
}

function codebaseCount(
  entry: FunctionCodebaseEntry,
  now: number,
): { count: string | number; tone?: 'danger'; title: string } {
  const codebase = entry.codebase
  const what = codebase.kind === 'extension' ? 'Extension instance' : 'Codebase'
  if (codebase.state === 'loading')
    return {
      count: discoveringText(codebase.loadingSince, now),
      title: `${what} ${codebase.id} is loading`,
    }
  if (codebase.state === 'failed') {
    const first = codebase.error?.message ?? 'The load failed.'
    return {
      count: codebase.servingPrevious ? 'Failed · previous load' : 'Failed',
      tone: 'danger',
      title: codebase.servingPrevious
        ? `${first} The functions below are from the previous load.`
        : first,
    }
  }
  if (codebase.functionCount === 0 && codebase.notLoaded.length === 0)
    return { count: 0, title: `${what} ${codebase.id} exports no functions` }
  return {
    count: codebase.functionCount,
    title: `${what} ${codebase.id} · ${codebase.directory}`,
  }
}

/** The snapshot as the panel's tree: "All functions", then every codebase with its functions. */
export function functionsTree(
  snapshot: FunctionsSnapshot,
  now: number = Date.now(),
): PanelTreeNode[] {
  const byCodebase = new Map<string, FunctionSummary[]>()
  for (const summary of snapshot.functions) {
    const list = byCodebase.get(summary.codebase)
    if (list) list.push(summary)
    else byCodebase.set(summary.codebase, [summary])
  }
  const nodes: PanelTreeNode[] = [
    {
      id: ALL_NODE,
      label: 'All functions',
      icon: ListIcon,
      count: snapshot.functions.length,
      title: 'Every function of every codebase',
    },
  ]
  const seen = new Set<string>()
  for (const entry of orderedCodebases(snapshot.codebases)) {
    const codebase = entry.codebase
    seen.add(codebase.id)
    const functions = (byCodebase.get(codebase.id) ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )
    const children: PanelTreeNode[] = functions.map(functionRow)
    for (const dropped of codebase.notLoaded)
      children.push({
        id: notLoadedNode(codebase.id, dropped.id),
        label: dropped.id.replace(/^[a-z]+-[a-z]+\d+-/, ''),
        icon: ProhibitIcon,
        count: 'not loaded',
        tone: 'warning',
        title: notLoadedText(dropped),
      })
    const count = codebaseCount(entry, now)
    nodes.push({
      id: codebaseNode(codebase.id),
      label: codebase.id,
      icon: codebase.kind === 'extension' ? PuzzlePieceIcon : FolderSimpleIcon,
      count: count.count,
      tone: count.tone,
      title: count.title,
      children,
    })
  }
  // A function whose codebase the snapshot does not list (never expected;
  // kept visible rather than dropped).
  for (const [codebase, functions] of byCodebase) {
    if (seen.has(codebase)) continue
    nodes.push({
      id: codebaseNode(codebase),
      label: codebase,
      icon: FolderSimpleIcon,
      count: functions.length,
      children: functions.map(functionRow),
    })
  }
  return nodes
}

/** Every codebase node open: what the panel starts with. */
export function openCodebases(snapshot: FunctionsSnapshot | undefined): Set<string> {
  return new Set((snapshot?.codebases ?? []).map((entry) => codebaseNode(entry.codebase.id)))
}
