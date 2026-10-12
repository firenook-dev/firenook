// The Extensions panel: the overview of every instance, then each instance
// by its id, on the panel tree every section draws its panel with (28 px
// rows, the data face, the accent bar on the one open). What tells two
// instances apart beyond the id — the extension's name, its version, where
// its source came from and whether it starts offline — is the row's
// tooltip; a state worth knowing before opening it (loading, did not load)
// is the row's figure.

import { PuzzlePieceIcon, SquaresFourIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { ExtensionDropped } from '@/api/generated/compute/ExtensionDropped'
import type { ExtensionInstanceSummary } from '@/api/generated/compute/ExtensionInstanceSummary'
import { PanelFilter, PanelHeader } from '@/components/console/panel'
import { type PanelTreeNode, PanelTree } from '@/components/console/panel-tree'
import { SectionPanel } from '@/components/shell/section-panel'
import { instanceTitle, originWord, readiness, stateChip, versionText } from '../words'

/** The overview's node id: no instance has an empty id. */
const ALL_INSTANCES = ''

/** Whether a filter's words all appear in what the row says about the instance. */
export function instanceMatches(summary: ExtensionInstanceSummary, filter: string): boolean {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = [
    summary.instanceId,
    summary.displayName,
    summary.name,
    summary.version,
    summary.reference,
    summary.written,
    originWord(summary),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return words.every((word) => text.includes(word))
}

/** What the row's tooltip says: the name, the version, the source and whether it starts offline. */
export function instanceNote(summary: ExtensionInstanceSummary): string {
  const title = instanceTitle(summary)
  return [
    title === summary.instanceId ? undefined : title,
    versionText(summary),
    originWord(summary),
    readiness(summary).word,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The panel's nodes: the overview, then one per instance the filter keeps
 * (its words are looked for in everything the row says, the tooltip
 * included); none at all when the filter keeps no instance, so the tree
 * says so.
 */
export function instanceNodes(
  instances: readonly ExtensionInstanceSummary[],
  loading: boolean,
  filter = '',
): PanelTreeNode[] {
  const kept = instances.filter((summary) => instanceMatches(summary, filter))
  if (kept.length === 0 && filter.trim() !== '') return []
  return [
    {
      id: ALL_INSTANCES,
      label: 'All instances',
      icon: SquaresFourIcon,
      count: loading ? undefined : instances.length,
      title: 'Every instance in firebase.json',
    },
    ...kept.map((summary): PanelTreeNode => {
      const state = stateChip(summary)
      return {
        id: summary.instanceId,
        label: summary.instanceId,
        icon: PuzzlePieceIcon,
        title: instanceNote(summary),
        count: state?.word,
        tone: state?.tone === 'danger' ? 'danger' : undefined,
      }
    }),
  ]
}

export function InstancesPanel({
  instances,
  dropped,
  current,
  onOpen,
  loading,
}: {
  instances: readonly ExtensionInstanceSummary[]
  dropped: readonly ExtensionDropped[]
  /** The instance open, or undefined for the overview. */
  current: string | undefined
  onOpen: (instance: string | undefined) => void
  loading: boolean
}) {
  const [filter, setFilter] = useState('')
  return (
    <SectionPanel label="Instances">
      <div className="flex h-full min-h-0 flex-col" data-testid="instances-panel">
        <PanelHeader
          filter={
            <PanelFilter
              value={filter}
              onChange={setFilter}
              placeholder="Filter instances"
              testId="instances-filter"
            />
          }
        >
          <span className="truncate text-[12px] text-kumo-subtle">Instances</span>
        </PanelHeader>
        <PanelTree
          nodes={instanceNodes(instances, loading, filter)}
          current={current ?? ALL_INSTANCES}
          expanded={new Set()}
          onToggle={() => undefined}
          onOpen={(node) => onOpen(node.id === ALL_INSTANCES ? undefined : node.id)}
          ariaLabel="Instances"
          empty={
            instances.length === 0
              ? 'No instances in firebase.json.'
              : 'No instance is named like that.'
          }
          testId="instance-list"
        />
        {dropped.length > 0 && (
          <div
            className="shrink-0 border-t border-kumo-line px-3 py-2 text-[11px] text-kumo-subtle"
            data-testid="instances-dropped"
          >
            Not emulated:{' '}
            {dropped.map((entry, index) => (
              <span key={entry.instanceId}>
                {index > 0 && ', '}
                <span className="font-mono">{entry.instanceId}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </SectionPanel>
  )
}
