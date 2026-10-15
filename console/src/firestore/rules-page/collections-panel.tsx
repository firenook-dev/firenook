// The rules against the data. Every collection the database holds, with
// the match blocks that govern its documents and what they allow; the
// ones no rule covers, where every client request is denied; the match
// blocks that reach no collection at all, which is usually a typo in a
// path. Only an emulator can draw this: it holds both the rules and the
// data. The engine's warnings about the rules are the Problems strip's.

import { Button, Text, useKumoToastManager } from '@cloudflare/kumo'
import { MagicWandIcon } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { checkQuery } from './api'
import type { CollectionRules } from '@/api/generated/CollectionRules'
import { fieldsQuery } from './schema-fields'
import { insertBlock, starterRules } from './starter'
import type { RulesDraft } from '@/rules/draft'

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
  const map = check.data?.map ?? null
  const errors = (check.data?.diagnostics ?? []).some((item) => item.severity === 'error')

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="collections">
      {check.isPending && (
        <div className="p-4">
          <Text size="sm" variant="secondary">
            Reading the rules…
          </Text>
        </div>
      )}
      {check.isError && (
        <div className="p-4">
          <Text size="sm" variant="secondary">
            {check.error.message}
          </Text>
        </div>
      )}
      {errors && (
        <div className="p-4">
          <Text size="sm" variant="secondary">
            Fix the errors in the editor to see which rules govern your data.
          </Text>
        </div>
      )}

      {map && (
        <>
          <section className="grid gap-2 px-3 py-3" data-testid="rules-map">
            <Text as="h3" size="xs" bold>
              Collections in your data
            </Text>
            {map.collections.length === 0 ? (
              <Text size="sm" variant="secondary">
                This database holds no documents yet.
              </Text>
            ) : (
              <ul className="grid gap-1">
                {map.collections.map((collection) => (
                  <CollectionRow
                    key={collection.pattern}
                    project={project}
                    database={database}
                    collection={collection}
                    draft={draft}
                    onReveal={onReveal}
                  />
                ))}
              </ul>
            )}
          </section>
          {map.unusedMatches.length > 0 && (
            <section
              className="grid gap-2 border-t border-kumo-line px-3 py-3"
              data-testid="rules-unused"
            >
              <Text as="h3" size="xs" bold>
                Rules that reach no data
              </Text>
              <Text size="xs" variant="secondary">
                No collection in the database matches these. A typo in a path, or a collection that
                is not there yet.
              </Text>
              <ul className="grid gap-0.5">
                {map.unusedMatches.map((unused) => (
                  <li key={`${unused.line}:${unused.path}`}>
                    <button
                      type="button"
                      onClick={() => onReveal(unused.line)}
                      className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:ink"
                    >
                      <span className="w-14 shrink-0 font-mono text-[11px] text-kumo-subtle">
                        line {unused.line}
                      </span>
                      <span className="min-w-0 truncate font-mono text-[12px]">
                        match {unused.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
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
  const toasts = useKumoToastManager()
  const [writing, setWriting] = useState(false)
  const granted = new Set(collection.governedBy.flatMap((block) => block.operations))

  const addStarter = async () => {
    setWriting(true)
    try {
      const fields = await queryClient.fetchQuery(
        fieldsQuery(project, database, collection.pattern),
      )
      const { text, line } = insertBlock(draft.source, starterRules(collection.pattern, fields))
      draft.setSource(text)
      onReveal(line)
      toasts.add({
        title: `Starter rules for ${collection.pattern} are in the editor`,
        description: 'Read them, then Apply. Nothing is in force until you do.',
      })
    } catch (error) {
      toasts.add({
        title: 'No starter rules',
        description: (error as Error).message,
        variant: 'error',
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
