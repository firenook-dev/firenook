// The Schemas page's panel (PS-50): the project picker and the filter in the
// head, then every schema of the project, flat, with its revision count —
// and a schema that topics use says so in its tooltip.

import { BracketsCurlyIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { PubsubSchemaSummary } from '@/api/generated/messaging/PubsubSchemaSummary'
import { statusQuery } from '@/api/queries'
import { PanelFilter, PanelHeader } from '@/components/console/panel'
import { type PanelTreeNode, PanelTree } from '@/components/console/panel-tree'
import { ScopeSelect } from '@/components/console/scope-select'
import { SectionPanel } from '@/components/shell/section-panel'
import { formatNumber } from '@/lib/format'
import { topicIndexQuery } from '../queries'

/** The panel filter's test id: `/` and `f` focus it. */
export const SCHEMA_FILTER_ID = 'pubsub-schema-filter'

/** The panel's rows: one per schema, its revision count beside it. */
export function schemaNodes(
  schemas: readonly PubsubSchemaSummary[],
  current: string | undefined,
): PanelTreeNode[] {
  return schemas.map((schema) => ({
    id: schema.name,
    label: schema.id,
    icon: BracketsCurlyIcon,
    // The schema in view counts itself in its tabs.
    ...(schema.name === current ? {} : { count: schema.revisions }),
    title:
      schema.usedBy.length === 0
        ? `${schema.id} · ${formatNumber(schema.revisions)} ${schema.revisions === 1 ? 'revision' : 'revisions'} · no topic uses it`
        : `${schema.id} · ${formatNumber(schema.revisions)} ${schema.revisions === 1 ? 'revision' : 'revisions'} · used by ${schema.usedBy.map((topic) => topic.slice(topic.lastIndexOf('/') + 1)).join(', ')}`,
  }))
}

export function SchemasPanel({
  schemas,
  project,
  current,
  onOpen,
  onProject,
}: {
  schemas: readonly PubsubSchemaSummary[]
  project: string
  /** The schema in view (its full name). */
  current: string | undefined
  onOpen: (name: string) => void
  onProject: (project: string) => void
}) {
  const status = useQuery(statusQuery)
  const configured = status.data?.projectId
  // The projects a picker offers: the emulator's, and every other the app wrote to.
  const index = useQuery(topicIndexQuery(project))
  const [filter, setFilter] = useState('')
  const ids = [
    ...new Set([
      configured ?? project,
      project,
      ...(index.data?.otherProjects.map((other) => other.project) ?? []),
    ]),
  ].toSorted((a, b) => (a === configured ? -1 : b === configured ? 1 : a.localeCompare(b)))
  return (
    <SectionPanel label="Schemas">
      <div className="flex min-h-0 flex-1 flex-col" data-testid="pubsub-schemas-panel">
        <PanelHeader
          filter={
            <PanelFilter
              value={filter}
              onChange={setFilter}
              placeholder="Filter schemas"
              testId={SCHEMA_FILTER_ID}
            />
          }
        >
          <ScopeSelect
            label="Project"
            value={project}
            items={ids.map((id) => ({
              value: id,
              label: id === '' ? '(empty)' : id,
              detail:
                id === project
                  ? `${formatNumber(schemas.length)} ${schemas.length === 1 ? 'schema' : 'schemas'}`
                  : undefined,
            }))}
            onChange={onProject}
            ariaLabel="Project"
            testId="pubsub-schemas-project"
            className="flex-1"
          />
        </PanelHeader>
        <PanelTree
          nodes={schemaNodes(schemas, current)}
          current={current}
          expanded={new Set()}
          onToggle={() => {}}
          onOpen={(node) => onOpen(node.id)}
          filter={filter}
          ariaLabel="Schemas"
          empty={schemas.length === 0 ? 'No schemas yet.' : 'No schema is named like that.'}
          testId="pubsub-schemas-tree"
        />
      </div>
    </SectionPanel>
  )
}
