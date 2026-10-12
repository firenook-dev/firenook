// The Extensions panel: every instance as a two-line row — its id in the
// data face and its name, then its version, where its source came from and
// whether it starts offline — under one row for the overview of all of
// them. The decisions list's rows, so the console has one way of drawing a
// list whose every item needs two facts to be told apart.

import { cn } from '@cloudflare/kumo'
import { PuzzlePieceIcon, SquaresFourIcon } from '@phosphor-icons/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, useState } from 'react'
import type { ExtensionDropped } from '@/api/generated/compute/ExtensionDropped'
import type { ExtensionInstanceSummary } from '@/api/generated/compute/ExtensionInstanceSummary'
import { PanelFilter, PanelHeader } from '@/components/console/panel'
import { SectionPanel } from '@/components/shell/section-panel'
import { StatusDot } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { instanceTitle, originWord, readiness, stateChip, versionText } from '../words'

/** Two lines, the decisions list's pitch. */
const ROW = 44

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
  'use no memo' // the virtualizer hands out functions the compiler cannot memoize safely
  const [filter, setFilter] = useState('')
  const shown = instances.filter((summary) => instanceMatches(summary, filter))
  const scroller = useRef<HTMLDivElement>(null)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const rows = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 8,
    getItemKey: (index) => shown[index]?.instanceId ?? index,
  })
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
        <button
          type="button"
          onClick={() => onOpen(undefined)}
          className={cn(
            'flex h-9 shrink-0 items-center gap-2 border-b border-kumo-hairline px-3 text-left text-[12px]',
            current === undefined
              ? 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-kumo-brand)]'
              : 'hover:ink',
          )}
          aria-current={current === undefined ? 'page' : undefined}
          data-testid="instance-row-all"
        >
          <SquaresFourIcon size={13} className="shrink-0 text-kumo-subtle" />
          <span className="min-w-0 flex-1 truncate text-kumo-default">All instances</span>
          <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
            {loading ? '…' : formatNumber(instances.length)}
          </span>
        </button>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" data-testid="instance-list">
          {shown.length === 0 && !loading ? (
            <p className="px-3 py-3 text-[12px] text-kumo-subtle">
              {instances.length === 0
                ? 'No instances in firebase.json.'
                : 'No instance is named like that.'}
            </p>
          ) : (
            <ul className="relative" style={{ height: rows.getTotalSize() }}>
              {rows.getVirtualItems().map((row) => {
                const summary = shown[row.index]
                if (!summary) return null
                return (
                  <li
                    key={row.key}
                    className="absolute inset-x-0"
                    style={{ top: row.start, height: ROW }}
                  >
                    <InstanceRow
                      summary={summary}
                      selected={summary.instanceId === current}
                      onOpen={() => onOpen(summary.instanceId)}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </div>
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

function InstanceRow({
  summary,
  selected,
  onOpen,
}: {
  summary: ExtensionInstanceSummary
  selected: boolean
  onOpen: () => void
}) {
  const ready = readiness(summary)
  const state = stateChip(summary)
  const title = instanceTitle(summary)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'grid h-full w-full content-center gap-0.5 border-b border-kumo-hairline px-3 text-left',
        selected ? 'bg-kumo-tint shadow-[inset_2px_0_0_var(--color-kumo-brand)]' : 'hover:ink',
      )}
      aria-current={selected ? 'page' : undefined}
      data-testid="instance-row"
      data-instance={summary.instanceId}
    >
      <span className="flex min-w-0 items-center gap-2">
        <PuzzlePieceIcon size={13} className="shrink-0 text-kumo-subtle" />
        <span className="shrink-0 font-mono text-[12px] text-kumo-default">
          {summary.instanceId}
        </span>
        {title !== summary.instanceId && (
          <span className="min-w-0 truncate text-[12px] text-kumo-subtle">{title}</span>
        )}
        {state && <StatusDot tone={state.tone} label={state.word} className="ml-auto" />}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-[21px] text-[11px] text-kumo-subtle">
        <span className="shrink-0 font-mono">{versionText(summary)}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">{originWord(summary)}</span>
        <span aria-hidden>·</span>
        <span className={cn('shrink-0', ready.tone === 'warning' && 'text-kumo-warning')}>
          {ready.word}
        </span>
      </span>
    </button>
  )
}
