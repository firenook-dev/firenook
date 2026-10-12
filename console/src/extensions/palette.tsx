// What ⌘K offers while the Extensions page is open: every instance by its
// id and name, and for the instance on screen what can be done to it.

import {
  ArrowClockwiseIcon,
  PackageIcon,
  PencilSimpleIcon,
  PuzzlePieceIcon,
} from '@phosphor-icons/react'
import { useEffect } from 'react'
import type { ExtensionInstanceSummary } from '@/api/generated/compute/ExtensionInstanceSummary'
import { type PaletteGroup, matchesQuery, usePaletteProviders } from '@/lib/palette'
import { instanceTitle, originWord } from './words'

export interface ExtensionsPaletteActions {
  open: (instance: string) => void
  configure: (instance: string) => void
  reload: (instance: string) => void
  vendor: (instance: string) => void
}

/** The palette's groups for a query: the instances, then the open instance's actions. */
export function extensionsPaletteGroups(
  instances: readonly ExtensionInstanceSummary[],
  current: ExtensionInstanceSummary | undefined,
  actions: ExtensionsPaletteActions,
  query: string,
): PaletteGroup[] {
  const groups: PaletteGroup[] = []
  const items = instances
    .map((summary) => ({
      id: `extensions.instance:${summary.instanceId}`,
      title: summary.instanceId,
      description: `${instanceTitle(summary)} · ${summary.version ?? 'no version'} · ${originWord(summary)}`,
      keywords: [summary.displayName, summary.name, summary.reference, summary.written]
        .filter(Boolean)
        .join(' '),
      icon: <PuzzlePieceIcon size={16} />,
      ref: { kind: 'extensions.instance', key: summary.instanceId },
      run: () => actions.open(summary.instanceId),
    }))
    .filter((item) => matchesQuery(item, query))
  if (items.length > 0) groups.push({ label: 'Extensions', items })
  if (current) {
    const id = current.instanceId
    const own = [
      {
        id: `extensions.reload:${id}`,
        title: `Reload ${id}`,
        keywords: 'restart refresh load again',
        icon: <ArrowClockwiseIcon size={16} />,
        run: () => actions.reload(id),
      },
      {
        id: `extensions.configure:${id}`,
        title: `Edit ${id}'s configuration`,
        keywords: 'reconfigure params parameters settings env',
        icon: <PencilSimpleIcon size={16} />,
        run: () => actions.configure(id),
      },
      ...(current.kind === 'registry'
        ? [
            {
              id: `extensions.vendor:${id}`,
              title: `Vendor ${id} for offline use`,
              keywords: 'offline copy source ext:vendor',
              icon: <PackageIcon size={16} />,
              run: () => actions.vendor(id),
            },
          ]
        : []),
    ].filter((item) => matchesQuery(item, query))
    if (own.length > 0) groups.push({ label: id, items: own })
  }
  return groups
}

/** Offers the page's instances and actions in ⌘K while it is mounted. */
export function useExtensionsPalette(
  instances: readonly ExtensionInstanceSummary[],
  current: ExtensionInstanceSummary | undefined,
  actions: ExtensionsPaletteActions,
): void {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  useEffect(() => {
    register('extensions', (query) => extensionsPaletteGroups(instances, current, actions, query))
    return () => unregister('extensions')
  }, [instances, current, actions, register, unregister])
}
