// The Functions section's panel: the project's shape at a glance — every
// codebase (the project's own, then extension instances) with its load
// state and count, and its functions under it with a glyph for the kind and
// a word only when one receives nothing. Clicking a codebase opens its
// codebase view; a function opens its page. The Invocations page draws the
// same tree and turns a click into a `function:` / `codebase:` term.

import { SkeletonLine } from '@cloudflare/kumo'
import { useState } from 'react'
import type { FunctionsSnapshot } from '@/api/generated/compute/FunctionsSnapshot'
import { PanelFilter, PanelHeader } from '@/components/console/panel'
import { PanelTree, type PanelTreeNode } from '@/components/console/panel-tree'
import { SectionPanel } from '@/components/shell/section-panel'
import { useNow } from '@/lib/clock'
import {
  ALL_NODE,
  type TreeTarget,
  codebaseNode,
  functionsTree,
  nodeTarget,
} from '../functions-tree'

export function FunctionsPanel({
  snapshot,
  current,
  onOpen,
}: {
  snapshot: FunctionsSnapshot | undefined
  /** The lit row: `ALL_NODE`, a codebase node or a function node. */
  current: string
  onOpen: (target: TreeTarget) => void
}) {
  const [filter, setFilter] = useState('')
  // Codebases start open; the panel remembers which ones were shut.
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set())
  const loading = snapshot?.codebases.some((entry) => entry.codebase.state === 'loading') ?? false
  return (
    <SectionPanel label="Functions">
      <div className="flex h-full min-h-0 flex-col" data-testid="functions-panel">
        <PanelHeader>
          <PanelFilter
            value={filter}
            onChange={setFilter}
            placeholder="Filter functions"
            testId="functions-filter"
          />
        </PanelHeader>
        {snapshot ? (
          loading ? (
            <TickingTree
              snapshot={snapshot}
              current={current}
              filter={filter}
              shut={shut}
              setShut={setShut}
              onOpen={onOpen}
            />
          ) : (
            <Tree
              nodes={functionsTree(snapshot)}
              snapshot={snapshot}
              current={current}
              filter={filter}
              shut={shut}
              setShut={setShut}
              onOpen={onOpen}
            />
          )
        ) : (
          <div className="grid gap-3 px-3 py-3" aria-hidden>
            {Array.from({ length: 6 }, (_, index) => (
              <SkeletonLine key={index} minWidth={50} maxWidth={90} />
            ))}
          </div>
        )}
      </div>
    </SectionPanel>
  )
}

/** The tree while a codebase loads: its "Discovering… 1.4 s" counts up by the shared clock. */
function TickingTree(props: Omit<Parameters<typeof Tree>[0], 'nodes'>) {
  const now = useNow('second')
  return <Tree {...props} nodes={functionsTree(props.snapshot, now)} />
}

function Tree({
  nodes,
  snapshot,
  current,
  filter,
  shut,
  setShut,
  onOpen,
}: {
  nodes: readonly PanelTreeNode[]
  snapshot: FunctionsSnapshot
  current: string
  filter: string
  shut: ReadonlySet<string>
  setShut: (shut: ReadonlySet<string>) => void
  onOpen: (target: TreeTarget) => void
}) {
  const expanded = new Set(
    snapshot.codebases
      .map((entry) => codebaseNode(entry.codebase.id))
      .filter((id) => !shut.has(id)),
  )
  return (
    <PanelTree
      nodes={nodes}
      current={current}
      expanded={expanded}
      onToggle={(id, open) => {
        const next = new Set(shut)
        if (open) next.delete(id)
        else next.add(id)
        setShut(next)
      }}
      onOpen={(node) => onOpen(nodeTarget(node.id))}
      filter={filter}
      ariaLabel="Functions"
      empty="No function or codebase is named like that."
      testId="functions-tree"
    />
  )
}

export { ALL_NODE }
