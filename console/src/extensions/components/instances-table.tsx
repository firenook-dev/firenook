// Every instance at a glance, when none is open: what it is, which version,
// where its source came from and whether that source is on this machine,
// how many functions it adds and how many the emulator leaves out, and the
// problems worth knowing before calling it. Instances the suite dropped
// whole are said above the table, since they have no row to carry them.

import { Tooltip } from '@cloudflare/kumo'
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CopyIcon,
  PuzzlePieceIcon,
} from '@phosphor-icons/react'
import type { ExtensionDropped } from '@/api/generated/compute/ExtensionDropped'
import type { ExtensionInstanceSummary } from '@/api/generated/compute/ExtensionInstanceSummary'
import { CodeBlock } from '@/components/console/code-block'
import {
  DataTable,
  type DataTableColumn,
  useHiddenColumnCount,
} from '@/components/console/data-table'
import { EmptyState, NoMatch } from '@/components/console/empty-state'
import type { RowMenuItem } from '@/components/console/row-menu'
import { SectionBanner } from '@/components/console/section-banner'
import { TableFooter } from '@/components/console/table-footer'
import { StatusDot } from '@/components/kit'
import { copyToClipboard } from '@/lib/copy'
import {
  ORIGIN_HELP,
  functionsText,
  instanceTitle,
  originWord,
  readiness,
  stateChip,
  versionText,
} from '../words'
import { instanceMatches } from './instances-panel'

/** The `firebase.json` lines that add an instance, for the empty state. */
export const ADD_EXTENSION_SNIPPET = `{
  "extensions": {
    "resize": "firebase/storage-resize-images@0.2.8"
  }
}`

/** The sentence for an instance the suite left out. */
export function droppedSentence(entry: ExtensionDropped): string {
  const services = entry.services.join(' and ')
  return `${entry.instanceId} (${entry.written}) includes ${services} triggered functions, and the ${services} emulator is not run, so the instance is left out.`
}

/** Where the table's widths and hidden columns are remembered. */
const MEMORY = 'extensions.overview'

const INSTANCES = { one: 'instance', other: 'instances' }

function columns(): DataTableColumn<ExtensionInstanceSummary>[] {
  return [
    {
      id: 'instance',
      header: 'Instance',
      width: 130,
      pinned: true,
      cell: (row) => <span className="truncate font-mono text-[12px]">{row.instanceId}</span>,
      copy: (row) => row.instanceId,
    },
    {
      id: 'extension',
      header: 'Extension',
      width: 150,
      cell: (row) => {
        const state = stateChip(row)
        return (
          <span className="flex min-w-0 items-center gap-2 font-sans">
            <span className="truncate text-[12px] text-kumo-default">{instanceTitle(row)}</span>
            {state && <StatusDot tone={state.tone} label={state.word} />}
          </span>
        )
      },
      copy: (row) => instanceTitle(row),
    },
    {
      id: 'version',
      header: 'Version',
      width: 80,
      cell: (row) => (
        <span className="truncate font-mono text-[12px] text-kumo-default">{versionText(row)}</span>
      ),
      copy: (row) => row.reference ?? row.version ?? '',
    },
    {
      id: 'source',
      header: 'Source',
      width: 100,
      cell: (row) => (
        <Tooltip
          content={row.origin ? ORIGIN_HELP[row.origin] : 'The instance has not loaded yet.'}
          render={
            <span className="truncate font-sans text-[12px] text-kumo-default">
              {originWord(row)}
            </span>
          }
        />
      ),
      copy: (row) => row.sourceDir ?? row.written,
    },
    {
      id: 'offline',
      header: 'Offline',
      width: 120,
      cell: (row) => {
        const ready = readiness(row)
        return (
          <Tooltip
            content={ready.note}
            render={
              <span className="inline-flex min-w-0 font-sans">
                <StatusDot tone={ready.tone} label={ready.word} />
              </span>
            }
          />
        )
      },
    },
    {
      id: 'functions',
      header: 'Functions',
      width: 140,
      cell: (row) => (
        <span className="truncate font-mono text-[12px] text-kumo-default tabular-nums">
          {functionsText(row)}
        </span>
      ),
    },
    {
      id: 'problems',
      header: 'Problems',
      width: 320,
      cell: (row) =>
        row.warnings.length === 0 && row.error === null ? (
          <span className="font-sans text-[12px] text-kumo-subtle">–</span>
        ) : (
          <Tooltip
            content={[...(row.error ? [row.error] : []), ...row.warnings].join(' ')}
            render={
              <span className="flex min-w-0 items-center gap-1.5 font-sans text-[12px] text-kumo-warning">
                <span className="size-1.5 shrink-0 rounded-full bg-kumo-warning" aria-hidden />
                <span className="truncate">{row.error ?? row.warnings[0]}</span>
                {row.warnings.length + (row.error ? 1 : 0) > 1 && (
                  <span className="shrink-0 text-kumo-subtle">
                    +{row.warnings.length + (row.error ? 1 : 0) - 1}
                  </span>
                )}
              </span>
            }
          />
        ),
    },
  ]
}

export function InstancesTable({
  instances,
  dropped,
  filter,
  onClearFilter,
  loading,
  onOpen,
  onReload,
}: {
  instances: readonly ExtensionInstanceSummary[]
  dropped: readonly ExtensionDropped[]
  filter: string
  onClearFilter: () => void
  loading: boolean
  onOpen: (instance: string, view?: 'configuration') => void
  onReload: (instance: string) => void
}) {
  const shown = instances.filter((summary) => instanceMatches(summary, filter))
  const table = columns()
  const hidden = useHiddenColumnCount(MEMORY, table)
  const menu = (row: ExtensionInstanceSummary): RowMenuItem[] => [
    {
      id: 'open',
      label: `Open ${row.instanceId}`,
      icon: ArrowSquareOutIcon,
      run: () => onOpen(row.instanceId),
    },
    {
      id: 'configure',
      label: `Edit ${row.instanceId}'s configuration`,
      icon: PuzzlePieceIcon,
      run: () => onOpen(row.instanceId, 'configuration'),
    },
    {
      id: 'reload',
      label: `Reload ${row.instanceId}`,
      icon: ArrowClockwiseIcon,
      run: () => onReload(row.instanceId),
    },
    {
      id: 'copy',
      label: 'Copy the instance id',
      icon: CopyIcon,
      run: () => {
        void copyToClipboard(row.instanceId, { what: row.instanceId })
      },
    },
  ]
  return (
    // min-w-0, or the column grows to the table's width and its own
    // scroller has nothing to scroll: the last columns ran off the window.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {dropped.map((entry) => (
        <SectionBanner key={entry.instanceId} tone="warning" testId="dropped-banner">
          Not emulated: {droppedSentence(entry)}
        </SectionBanner>
      ))}
      <DataTable
        ariaLabel="Extension instances"
        rows={shown}
        rowKey={(row) => row.instanceId}
        columns={table}
        memoryKey={MEMORY}
        onOpen={(row) => onOpen(row.instanceId)}
        rowMenu={menu}
        loading={loading}
        total={{ count: shown.length, exact: true }}
        footer={
          shown.length > 0 && (
            <TableFooter
              loaded={shown.length}
              hasMore={false}
              hiddenColumns={hidden.hidden}
              onShowAll={hidden.showAll}
              noun={INSTANCES}
              testId="instances-footer"
            />
          )
        }
        testId="instances-table"
        empty={
          instances.length > 0 ? (
            <NoMatch filter={filter} onClear={onClearFilter} noun="instances" />
          ) : (
            <EmptyState
              icon={PuzzlePieceIcon}
              title="No extensions in this project"
              description={
                dropped.length > 0
                  ? 'Every instance in firebase.json was left out; the banner above says why.'
                  : 'Add an instance to firebase.json and restart the suite; a local extension is a path to its directory.'
              }
              actions={
                <div className="w-[min(560px,100%)] text-left">
                  <CodeBlock
                    label="Add it to firebase.json"
                    code={ADD_EXTENSION_SNIPPET}
                    language="json"
                    testId="extensions-snippet"
                  />
                </div>
              }
              testId="extensions-empty"
            />
          )
        }
      />
    </div>
  )
}
