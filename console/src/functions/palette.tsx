// What ⌘K offers while a Functions page is open: every function (open its
// page), the open function's own actions, every codebase (open it, reload
// it, restart its worker), and the section's lists. Matched word-wise like
// every provider; a function row names the thing the engine's search would
// also find, so ⌘K shows it once.

import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CopyIcon,
  FolderSimpleIcon,
  ListIcon,
  PlayIcon,
  PowerIcon,
  PuzzlePieceIcon,
  ScrollIcon,
} from '@phosphor-icons/react'
import { useEffect } from 'react'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { KIND_ICON, actionTitle } from './kinds'
import { orderedCodebases } from './functions-tree'

export interface FunctionsPaletteActions {
  openFunction: (id: string) => void
  openCodebase: (codebase: string) => void
  reload: (codebase: string) => void
  restart: (codebase: string) => void
  showInvocations: (q?: string) => void
  /** The open function's actions. */
  current?:
    | {
        id: string
        run?: (() => void) | undefined
        copyUrl?: (() => void) | undefined
        logs?: (() => void) | undefined
      }
    | undefined
  /** "Clear the invocation history…", where the page offers it. */
  clearHistory?: (() => void) | undefined
}

/** The provider's groups for a search text. */
export function functionsPaletteGroups(
  snapshot: FunctionsSnapshot,
  actions: FunctionsPaletteActions,
  query: string,
): PaletteGroup[] {
  const groups: PaletteGroup[] = []
  const keep = (items: PaletteItem[]) => items.filter((item) => matchesQuery(item, query))

  const current = actions.current
  const open = current ? snapshot.functions.find((summary) => summary.id === current.id) : undefined
  if (current && open) {
    const items: PaletteItem[] = []
    if (current.run)
      items.push({
        id: 'functions.run',
        title: actionTitle(open.kind, open.name),
        icon: <PlayIcon size={16} />,
        run: current.run,
      })
    if (current.copyUrl)
      items.push({
        id: 'functions.copy-url',
        title: `Copy ${open.name}'s URL`,
        icon: <CopyIcon size={16} />,
        run: current.copyUrl,
      })
    if (current.logs)
      items.push({
        id: 'functions.logs',
        title: `Open ${open.name} in Logs`,
        icon: <ScrollIcon size={16} />,
        run: current.logs,
      })
    items.push({
      id: 'functions.function-invocations',
      title: `Show ${open.name}'s invocations`,
      icon: <ListIcon size={16} />,
      run: () => actions.showInvocations(`function:${open.id}`),
    })
    const shown = keep(items)
    if (shown.length > 0) groups.push({ label: 'Function actions', items: shown })
  }

  const functions = keep(
    snapshot.functions.map((summary) => {
      const Glyph = KIND_ICON[summary.kind]
      return {
        id: `functions.function:${summary.id}`,
        title: summary.name,
        breadcrumbs: [summary.codebase],
        description: `${summary.kind} · ${summary.region}`,
        keywords: `${summary.id} ${summary.entryPoint} ${summary.kind} ${summary.trigger.document ?? ''} ${summary.trigger.eventType ?? ''}`,
        icon: <Glyph size={16} />,
        ref: { kind: 'functions.function', key: summary.id },
        run: () => actions.openFunction(summary.id),
      }
    }),
  )
  if (functions.length > 0) groups.push({ label: 'Functions', items: functions })

  const codebases: PaletteItem[] = []
  for (const entry of orderedCodebases(snapshot.codebases)) {
    const id = entry.codebase.id
    const extension = entry.codebase.kind === 'extension'
    codebases.push({
      id: `functions.codebase:${id}`,
      title: `Open ${id}`,
      description: extension ? 'extension instance' : entry.codebase.directory,
      keywords: 'codebase worker load log',
      icon: extension ? <PuzzlePieceIcon size={16} /> : <FolderSimpleIcon size={16} />,
      run: () => actions.openCodebase(id),
    })
    if (!extension)
      codebases.push({
        id: `functions.reload:${id}`,
        title: `Reload ${id}`,
        keywords: 'codebase discovery env',
        icon: <ArrowClockwiseIcon size={16} />,
        run: () => actions.reload(id),
      })
    codebases.push({
      id: `functions.restart:${id}`,
      title: `Restart the ${id} worker`,
      keywords: 'codebase process node',
      icon: <PowerIcon size={16} />,
      run: () => actions.restart(id),
    })
  }
  const shownCodebases = keep(codebases)
  if (shownCodebases.length > 0) groups.push({ label: 'Codebases', items: shownCodebases })

  const lists: PaletteItem[] = [
    {
      id: 'functions.invocations-all',
      title: 'Show every invocation',
      keywords: 'runs executions history',
      icon: <ArrowSquareOutIcon size={16} />,
      run: () => actions.showInvocations(),
    },
  ]
  if (actions.clearHistory)
    lists.push({
      id: 'functions.clear-history',
      title: 'Clear the invocation history…',
      keywords: 'invocations delete empty',
      icon: <ListIcon size={16} />,
      run: actions.clearHistory,
    })
  const shownLists = keep(lists)
  if (shownLists.length > 0) groups.push({ label: 'Invocations', items: shownLists })
  return groups
}

/** Registers the provider while a Functions page is mounted. */
export function useFunctionsPalette(
  snapshot: FunctionsSnapshot | undefined,
  actions: FunctionsPaletteActions,
): void {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  useEffect(() => {
    if (!snapshot) return undefined
    register('functions', (query) => functionsPaletteGroups(snapshot, actions, query))
    return () => unregister('functions')
  }, [snapshot, actions, register, unregister])
}
