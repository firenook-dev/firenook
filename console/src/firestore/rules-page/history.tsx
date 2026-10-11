// What governed this database over time: every ruleset installed — at
// startup, applied here, changed in the file on disk, hot-reloaded by a
// test suite — newest first, each against the text in the editor, and any
// of them one click from being the draft again. Plus the file on disk
// itself, when it is not what is in force.

import { Badge, Button, Dialog, Text, Tooltip } from '@cloudflare/kumo'
import { ClockCounterClockwiseIcon, XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { relativeTime } from '../value'
import { historyQuery } from './api'
import { type DiffLine, diffLines, diffSize } from './diff'
import type { RulesDraft } from './use-rules-draft'

const ORIGIN_LABELS: Record<string, string> = {
  startup: 'Loaded at startup',
  console: 'Applied in the console',
  file: 'Changed on disk',
  reload: 'Hot-reloaded by a client',
}

interface Version {
  key: string
  label: string
  source: string
  time: string | undefined
  current: boolean
}

export function HistoryButton({ database, draft }: { database: string; draft: RulesDraft }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip
        content="Every version of these rules, and the file on disk"
        render={
          <Button
            variant="ghost"
            size="sm"
            icon={<ClockCounterClockwiseIcon />}
            onClick={() => setOpen(true)}
            data-testid="rules-history"
          >
            History
          </Button>
        }
      />
      {open && <HistoryDialog database={database} draft={draft} onClose={() => setOpen(false)} />}
    </>
  )
}

function HistoryDialog({
  database,
  draft,
  onClose,
}: {
  database: string
  draft: RulesDraft
  onClose: () => void
}) {
  const history = useQuery(historyQuery(database))
  const fileSource = draft.fileSource
  const versions: Version[] = []
  if (fileSource !== null && fileSource !== draft.inForce)
    versions.push({
      key: 'file',
      label: 'The file on disk',
      source: fileSource,
      time: undefined,
      current: false,
    })
  for (const [index, version] of (history.data ?? []).entries())
    versions.push({
      key: `${version.hash}-${version.installedAt}`,
      label: ORIGIN_LABELS[version.origin] ?? version.origin,
      source: version.source,
      time: version.installedAt,
      current: index === 0,
    })
  const [chosen, setChosen] = useState<string | undefined>()
  const selected = versions.find((version) => version.key === chosen) ?? versions[0]
  const lines = selected ? diffLines(selected.source, draft.source) : []
  const size = diffSize(lines)

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog size="xl" className="flex h-[min(720px,85vh)] flex-col p-0">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-kumo-line px-5 py-3">
          <Dialog.Title className="text-base font-semibold">Rules history</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
          />
        </div>
        <div className="flex min-h-0 flex-1">
          <ul
            className="w-64 shrink-0 overflow-y-auto border-r border-kumo-line p-2"
            data-testid="history-versions"
          >
            {history.isPending && (
              <li className="p-2">
                <Text size="sm" variant="secondary">
                  Loading…
                </Text>
              </li>
            )}
            {history.isError && (
              <li className="p-2">
                <Text size="sm" variant="secondary">
                  {history.error.message}
                </Text>
              </li>
            )}
            {versions.map((version) => (
              <li key={version.key}>
                <button
                  type="button"
                  onClick={() => setChosen(version.key)}
                  className={`grid w-full gap-0.5 rounded-md px-2.5 py-2 text-left hover:ink ${
                    version.key === selected?.key ? 'bg-kumo-tint' : ''
                  }`}
                  data-testid="history-version"
                >
                  <span className="flex items-center gap-1.5 text-[13px] text-kumo-default">
                    {version.label}
                    {version.current && <Badge variant="outline">In force</Badge>}
                  </span>
                  {version.time && (
                    <span className="text-[11px] text-kumo-subtle">
                      {relativeTime(version.time)} · {new Date(version.time).toLocaleTimeString()}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-w-0 flex-1 flex-col">
            {selected ? (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-kumo-line px-4 py-2">
                  <Text size="sm" variant="secondary">
                    {size.removed + size.added === 0
                      ? 'The same as the editor.'
                      : `Against the editor: ${size.added} line${size.added === 1 ? '' : 's'} added, ${size.removed} removed`}
                  </Text>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="ml-auto"
                    disabled={selected.source === draft.source}
                    onClick={() => {
                      draft.setSource(selected.source)
                      onClose()
                    }}
                    data-testid="history-restore"
                  >
                    Put in the editor
                  </Button>
                </div>
                <DiffView lines={lines} />
              </>
            ) : (
              <div className="p-4">
                <Text size="sm" variant="secondary">
                  No versions yet.
                </Text>
              </div>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

/** A diff read top to bottom: the version on the left of the gutter, the editor on the right. */
function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-kumo-control" data-testid="history-diff">
      <table className="w-full border-collapse font-mono text-[12px] leading-5">
        <tbody>
          {lines.map((line, index) => (
            <tr
              // A diff line has no identity of its own; its place in the
              // diff is what it is.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className={
                line.kind === 'added'
                  ? 'bg-kumo-success-tint'
                  : line.kind === 'removed'
                    ? 'bg-kumo-danger-tint'
                    : ''
              }
              data-kind={line.kind}
            >
              <td className="w-10 pr-2 text-right text-kumo-inactive tabular-nums select-none">
                {line.before ?? ''}
              </td>
              <td className="w-10 pr-2 text-right text-kumo-inactive tabular-nums select-none">
                {line.after ?? ''}
              </td>
              <td className="w-4 text-kumo-subtle select-none">
                {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
              </td>
              <td className="pr-4 whitespace-pre text-kumo-default">{line.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
