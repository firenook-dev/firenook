// What the engine does with this query, and what production would ask of it.
//
// The panel answers in one sentence first — "Reads every document in
// teams/t1/orders" — because that is the finding a person acts on. The
// numbers sit beside it, and the index requirement gets a card of its own:
// a query that runs here and fails after a deploy is the failure this whole
// panel exists to prevent.

import { Badge, Button, Text } from '@cloudflare/kumo'
import { CheckCircleIcon, CopyIcon, LightningIcon, WarningIcon, XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  type Explanation,
  STRATEGY_DETAIL,
  STRATEGY_LABELS,
  describeCandidates,
  describeOrders,
  explainQueryOptions,
  formatElapsed,
  queryToExplain,
} from '../explain'
import { printQuery } from '../query'
import { documentRoot } from '../rest'
import { formatNumber } from '../value'
import { splitCollection } from '../queries'
import { useWorkbench } from './workbench-context'

export function ExplainPanel({ onClose }: { onClose: () => void }) {
  const workbench = useWorkbench()
  const { parent, collectionId } = splitCollection(workbench.collectionPath, workbench.group)
  const structured = queryToExplain(
    collectionId,
    workbench.group,
    workbench.query,
    documentRoot(workbench.scope),
  )
  const explanation = useQuery({
    ...explainQueryOptions(
      workbench.database,
      parent,
      workbench.collectionPath,
      printQuery(workbench.query),
      structured,
    ),
    enabled: Boolean(workbench.collectionPath) && !workbench.queryError,
  })

  return (
    <section
      className="grid shrink-0 gap-3 border-b border-kumo-line bg-kumo-base px-3 py-2.5"
      data-testid="explain-panel"
      aria-label="Query plan"
    >
      <div className="flex items-start gap-2">
        <span className="flex h-lh shrink-0 items-center text-kumo-subtle">
          <LightningIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          {explanation.isError ? (
            <Text variant="error" size="sm">
              {explanation.error.message}
            </Text>
          ) : explanation.data ? (
            <Summary explanation={explanation.data} />
          ) : (
            <Text variant="secondary" size="sm">
              Running the query to measure it…
            </Text>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<XIcon />}
          onClick={onClose}
          aria-label="Close the query plan"
        />
      </div>
      {explanation.data?.index ? <IndexCard index={explanation.data.index} /> : null}
    </section>
  )
}

function Summary({ explanation }: { explanation: Explanation }) {
  const matched = formatNumber(explanation.documentsMatched)
  return (
    <div className="grid gap-1.5">
      <Text size="sm" as="p" data-testid="explain-headline">
        {describeCandidates(explanation.candidates, explanation.target)}
      </Text>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Fact
          name="matched"
          label={explanation.limited ? 'matched at least' : 'matched'}
          value={`${matched} ${explanation.documentsMatched === 1 ? 'document' : 'documents'}`}
          title={
            explanation.limited
              ? "The query's own limit stopped it, so this is a floor and not the total."
              : 'Documents the engine matched, with no rules applied.'
          }
        />
        <Fact
          name="took"
          label="took"
          value={formatElapsed(explanation.elapsedMicros)}
          title="How long the engine took to answer it just now."
        />
        <Fact
          name="strategy"
          label="results"
          value={STRATEGY_LABELS[explanation.strategy]}
          title={STRATEGY_DETAIL[explanation.strategy]}
        />
        <Fact
          name="order"
          label="ordered by"
          value={describeOrders(explanation.orders)}
          title="The engine always orders by __name__ last, which is what makes the paging cursor exact."
          mono
        />
        {explanation.scope === 'collectionGroup' && <Badge variant="outline">group</Badge>}
      </div>
    </div>
  )
}

function Fact({
  name,
  label,
  value,
  title,
  mono = false,
}: {
  name: string
  label: string
  value: string
  title: string
  mono?: boolean
}) {
  return (
    // `title` rather than a Tooltip: these sit inline in a row of text, and
    // Kumo's Tooltip renders a button, which must not nest in one.
    <span
      className="flex items-baseline gap-1 text-[13px]"
      title={title}
      data-testid={`explain-${name}`}
    >
      <span className="text-kumo-subtle">{label}</span>
      <span className={`text-kumo-default ${mono ? 'font-mono text-[0.92em]' : ''} tabular-nums`}>
        {value}
      </span>
    </span>
  )
}

function IndexCard({ index }: { index: NonNullable<Explanation['index']> }) {
  const [copied, setCopied] = useState(false)
  const kind = index.composite ? 'composite index' : 'collection-group index'
  return (
    <div
      className={`grid gap-2 rounded-md p-2.5 ring ${
        index.declared
          ? 'bg-kumo-success-tint ring-kumo-hairline'
          : 'bg-kumo-warning-tint ring-kumo-warning'
      }`}
      data-testid="explain-index"
      data-declared={index.declared}
    >
      <div className="flex items-start gap-2">
        <span className="flex h-lh shrink-0 items-center text-kumo-subtle">
          {index.declared ? <CheckCircleIcon size={16} /> : <WarningIcon size={16} />}
        </span>
        <div className="grid min-w-0 flex-1 gap-1.5">
          <Text size="sm" as="p">
            {index.declared
              ? `firestore.indexes.json declares the ${kind} this query needs.`
              : `Production needs a ${kind} for this query. The emulator answers it either way, so it would fail after a deploy, not here.`}
          </Text>
          {/* The entry sits with the fields it declares, not beside the
              sentence, so a long sentence never squeezes the button. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[12px] text-kumo-subtle">
                {index.collectionGroup}
              </span>
              {index.fields.map((field) => (
                <span
                  key={field.fieldPath}
                  className="flex h-5 items-center rounded bg-kumo-base px-1.5 font-mono text-[11px] text-kumo-default"
                >
                  {field.fieldPath}
                  <span className="pl-1 text-kumo-subtle">{modeMark(field)}</span>
                </span>
              ))}
            </div>
            {!index.declared && (
              <Button
                variant="secondary"
                size="sm"
                icon={copied ? <CheckCircleIcon /> : <CopyIcon />}
                onClick={() => {
                  void navigator.clipboard.writeText(index.configEntry)
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1500)
                }}
                title="Copy the firestore.indexes.json entry"
                data-testid="copy-index-entry"
              >
                {copied ? 'Copied' : 'Copy entry'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The arrow or word that stands for a field's index mode. */
function modeMark(field: NonNullable<Explanation['index']>['fields'][number]): string {
  switch (field.mode) {
    case 'ascending':
      return '\u2191'
    case 'descending':
      return '\u2193'
    case 'arrayContains':
      return 'array'
    default:
      return `vector ${field.dimension ?? ''}`.trim()
  }
}
