// The Topics page's panel: the project picker and the filter in the head,
// then the tree of topics, their subscriptions and the functions that
// consume them, with the groups after (schedules, other projects, topics
// deleted). Every figure in it is live: the counters topic patches the
// index the tree is built from.

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import { statusQuery } from '@/api/queries'
import { PanelFilter, PanelHeader } from '@/components/console/panel'
import { PanelTree } from '@/components/console/panel-tree'
import { ScopeSelect } from '@/components/console/scope-select'
import { SectionPanel } from '@/components/shell/section-panel'
import { useNow } from '@/lib/clock'
import { formatNumber } from '@/lib/format'
import { type TreeTarget, pathToCurrent, topicTree } from '../tree'
import { useTopicTree } from '../tree-store'

/** The panel filter's test id, which the landing's "filter them in the panel" focuses. */
export const PANEL_FILTER_ID = 'pubsub-panel-filter'

export function TopicsPanel({
  index,
  project,
  current,
  onOpen,
  onProject,
}: {
  index: PubsubTopicIndex | undefined
  project: string
  /** The node the page shows: a topic or subscription full name, or a function id. */
  current: string | undefined
  onOpen: (target: TreeTarget) => void
  onProject: (project: string) => void
}) {
  const status = useQuery(statusQuery)
  const configured = status.data?.projectId
  const [filter, setFilter] = useState('')
  const open = useTopicTree((state) => state.open)
  const setOpen = useTopicTree((state) => state.setOpen)
  const reveal = useTopicTree((state) => state.reveal)
  // Figures turn amber as a backlog ages, so the tree reads the minute clock.
  const now = useNow('minute')
  const tree = topicTree(index, { current, configured, now })

  // Where you are shows, with what is open beneath it.
  const path = pathToCurrent(index, current).join('\n')
  useEffect(() => {
    if (path) reveal(path.split('\n'))
  }, [path, reveal])

  const projects = projectItems(index, project, configured)
  return (
    <SectionPanel label="Topics">
      <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-panel">
        <PanelHeader
          filter={
            <PanelFilter
              value={filter}
              onChange={setFilter}
              placeholder="Filter topics and subscriptions"
              testId={PANEL_FILTER_ID}
            />
          }
        >
          <ScopeSelect
            label="Project"
            value={project}
            items={projects}
            onChange={onProject}
            ariaLabel="Project"
            testId="pubsub-project"
            className="flex-1"
          />
        </PanelHeader>
        <PanelTree
          nodes={tree.nodes}
          current={current}
          expanded={open}
          onToggle={setOpen}
          onOpen={(node) => {
            const target = tree.targets.get(node.id)
            if (target) onOpen(target)
            else setOpen(node.id, !open.has(node.id))
          }}
          filter={filter}
          ariaLabel="Topics"
          empty="No topic or subscription is named like that."
          testId="pubsub-tree"
        />
      </div>
    </SectionPanel>
  )
}

/** The project picker's list: the emulator's own first, then every other project holding a topic. */
function projectItems(
  index: PubsubTopicIndex | undefined,
  project: string,
  configured: string | undefined,
) {
  const counts = new Map<string, number>()
  if (index) {
    counts.set(index.project, index.items.length)
    for (const other of index.otherProjects) counts.set(other.project, other.topics)
  }
  const ids = [...new Set([configured ?? project, project, ...counts.keys()])]
  ids.sort((a, b) => (a === configured ? -1 : b === configured ? 1 : a.localeCompare(b)))
  return ids.map((id) => {
    const topics = counts.get(id)
    return {
      value: id,
      label: id === '' ? '(empty)' : id,
      detail:
        topics === undefined
          ? undefined
          : `${formatNumber(topics)} ${topics === 1 ? 'topic' : 'topics'}`,
    }
  })
}
