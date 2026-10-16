// One list of what can be done to a function, in one order, wherever it is
// offered: the overview row's menu (right-click, Shift+F10, ⋯), the function
// toolbar's ⋯, and ⌘K while the function is open. The caller supplies how
// each thing happens (navigation, the dialogs it owns); this decides which
// items exist and what they are called.

import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CopyIcon,
  FolderSimpleIcon,
  ListIcon,
  PlayIcon,
  PowerIcon,
  ScrollIcon,
} from '@phosphor-icons/react'
import type { FunctionCodebase } from '@/api/generated/compute/FunctionCodebase'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import type { RowMenuItem } from '@/components/console/row-menu'
import { kindVerb } from './kinds'

export interface FunctionMenuActions {
  open?: (() => void) | undefined
  /** Opens the Run tab (the kind's verb). */
  run?: (() => void) | undefined
  copy: (text: string, what: string) => void
  /** The function's URL as apps reach it (HTTP-shaped kinds). */
  url?: string | undefined
  /** Copy as curl, when the Run tab can build one. */
  copyCurl?: (() => void) | undefined
  /** Open in Logs, while the engine runs Logs. */
  logs?: (() => void) | undefined
  invocations: () => void
  openCodebase?: (() => void) | undefined
  reload?: (() => void) | undefined
  restart?: (() => void) | undefined
}

/** Why a codebase cannot be reloaded from here, or undefined when it can. */
export function reloadRefusal(
  codebase: Pick<FunctionCodebase, 'kind'> | undefined,
): string | undefined {
  if (codebase?.kind === 'extension')
    return 'An extension instance reloads in Extensions, with its parameters.'
  return undefined
}

export function functionMenu(
  summary: FunctionSummary,
  codebase: FunctionCodebase | undefined,
  actions: FunctionMenuActions,
): RowMenuItem[] {
  const items: RowMenuItem[] = []
  if (actions.open)
    items.push({
      id: 'open',
      label: 'Open',
      icon: ArrowSquareOutIcon,
      shortcut: 'Enter',
      run: actions.open,
    })
  if (actions.run)
    items.push({
      id: 'run',
      label: kindVerb(summary.kind),
      icon: PlayIcon,
      shortcut: 'i',
      run: actions.run,
    })
  if (actions.url) {
    const url = actions.url
    items.push({
      id: 'copy-url',
      label: 'Copy URL',
      icon: CopyIcon,
      run: () => actions.copy(url, 'the URL'),
    })
  }
  items.push({
    id: 'copy-id',
    label: 'Copy id',
    icon: CopyIcon,
    run: () => actions.copy(summary.id, 'the id'),
  })
  if (actions.copyCurl)
    items.push({ id: 'copy-curl', label: 'Copy as curl', icon: CopyIcon, run: actions.copyCurl })
  if (actions.logs)
    items.push({
      id: 'logs',
      label: 'Open in Logs',
      icon: ScrollIcon,
      shortcut: 'l',
      run: actions.logs,
    })
  items.push({
    id: 'invocations',
    label: 'Show all invocations',
    icon: ListIcon,
    run: actions.invocations,
  })
  if (actions.openCodebase)
    items.push({
      id: 'codebase',
      label: 'Open codebase',
      icon: FolderSimpleIcon,
      run: actions.openCodebase,
    })
  if (actions.reload) {
    const refusal = reloadRefusal(codebase)
    items.push({
      id: 'reload',
      label: 'Reload codebase',
      icon: ArrowClockwiseIcon,
      ...(refusal ? { disabled: refusal } : {}),
      run: actions.reload,
    })
  }
  if (actions.restart)
    items.push({ id: 'restart', label: 'Restart worker…', icon: PowerIcon, run: actions.restart })
  return items
}
