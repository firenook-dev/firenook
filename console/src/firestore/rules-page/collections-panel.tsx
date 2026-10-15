// The rules against the data, Firestore's map for the rules kit's map
// panel (`src/rules/map-panel.tsx`): every collection the database holds,
// with the match blocks that govern its documents and what they allow; the
// ones no rule covers, where every client request is denied, each with
// starter rules drawn from its documents; and the match blocks that reach
// no collection at all.

import { Button, Text } from '@cloudflare/kumo'
import { MagicWandIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { CollectionRules } from '@/api/generated/CollectionRules'
import { toast } from '@/lib/toasts'
import type { RulesDraft } from '@/rules/draft'
import { RulesMapPanel } from '@/rules/map-panel'
import { FIRESTORE_ROOT, insertStarter } from '@/rules/starter'
import { checkQuery } from './api'
import { fieldsQuery } from './schema-fields'
import { starterRules } from './starter'

const OPERATIONS = ['get', 'list', 'create', 'update', 'delete'] as const

export function CollectionsPanel({
  project,
  database,
  draft,
  checked,
  onReveal,
}: {
  project: string
  database: string
  draft: RulesDraft
  /** The text the page last checked, which the map describes; none before the rules load. */
  checked: string | undefined
  onReveal: (line: number) => void
}) {
  const check = useQuery({ ...checkQuery(database, checked ?? ''), enabled: checked !== undefined })
  const map = check.data?.map
  return (
    <RulesMapPanel
      testId="collections"
      check={check}
      checked={checked}
      map={map ? { rows: map.collections.length, unused: map.unusedMatches } : undefined}
      title="Collections in your data"
      holds="data"
      unused={{
        title: 'Rules that reach no data',
        note: 'No collection in the database matches these. A typo in a path, or a collection that is not there yet.',
      }}
      emptyText="This database holds no documents yet."
      onReveal={onReveal}
      rows={map?.collections.map((collection) => (
        <CollectionRow
          key={collection.pattern}
          project={project}
          database={database}
          collection={collection}
          draft={draft}
          onReveal={onReveal}
        />
      ))}
    />
  )
}

function CollectionRow({
  project,
  database,
  collection,
  draft,
  onReveal,
}: {
  project: string
  database: string
  collection: CollectionRules
  draft: RulesDraft
  onReveal: (line: number) => void
}) {
  const queryClient = useQueryClient()
  const [writing, setWriting] = useState(false)
  const granted = new Set(collection.governedBy.flatMap((block) => block.operations))

  const addStarter = async () => {
    setWriting(true)
    try {
      const fields = await queryClient.fetchQuery(
        fieldsQuery(project, database, collection.pattern),
      )
      insertStarter(
        draft,
        [starterRules(collection.pattern, fields)],
        FIRESTORE_ROOT,
        `Starter rules for ${collection.pattern} are in the editor`,
        onReveal,
      )
    } catch (error) {
      toast({
        key: 'rules-starter',
        title: 'No starter rules',
        description: (error as Error).message,
        tone: 'danger',
      })
    } finally {
      setWriting(false)
    }
  }

  return (
    <li
      className="grid gap-1 rounded-md px-2 py-1.5 hover:ink"
      data-testid="rules-collection"
      data-pattern={collection.pattern}
      data-uncovered={collection.uncovered || undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-[12px] text-kumo-default">
          {collection.pattern}
        </span>
        {collection.uncovered ? (
          <span className="ml-auto shrink-0 text-[11px] text-kumo-warning">no rule</span>
        ) : (
          <span className="ml-auto flex shrink-0 gap-1">
            {OPERATIONS.map((operation) => (
              <span
                key={operation}
                className={`rounded px-1 font-mono text-[10.5px] ${
                  granted.has(operation)
                    ? 'bg-kumo-tint text-kumo-default'
                    : 'text-kumo-inactive line-through'
                }`}
                title={
                  granted.has(operation)
                    ? `An allow covers ${operation}, under its condition`
                    : `Nothing allows ${operation}`
                }
              >
                {operation}
              </span>
            ))}
          </span>
        )}
      </div>
      {collection.uncovered ? (
        <div className="flex items-center gap-2">
          <Text size="xs" variant="secondary">
            Every client request here is denied.
          </Text>
          <Button
            variant="ghost"
            size="xs"
            icon={<MagicWandIcon />}
            className="ml-auto"
            loading={writing}
            onClick={() => void addStarter()}
            data-testid="rules-starter"
          >
            Add starter rules
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
          {collection.governedBy.map((block) => (
            <button
              key={`${block.line}:${block.path}`}
              type="button"
              onClick={() => onReveal(block.line)}
              className="min-w-0 truncate text-left font-mono text-[11px] text-kumo-subtle hover:text-kumo-default hover:underline"
            >
              line {block.line}: match {block.path}
            </button>
          ))}
        </div>
      )}
    </li>
  )
}
