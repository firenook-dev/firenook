// What governed this scope over time: every ruleset installed — at
// startup, applied here, changed in the file on disk, hot-reloaded by a
// test suite — newest first, each against the text in the editor, and any
// of them one click from being the draft again. Plus the file on disk
// itself, when it is not what is in force. Each page names its origins in
// its own words (Firestore's reload is a client's hot reload, Storage's
// comes through `/internal/setRules`).

import { Badge, Button, Dialog, Text, Tooltip } from '@cloudflare/kumo'
import { ClockCounterClockwiseIcon, XIcon } from '@phosphor-icons/react'
import { type QueryKey, type UseQueryOptions, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { RulesOrigin } from '@/api/generated/RulesOrigin'
import type { RulesVersion } from '@/api/generated/RulesVersion'
import { relativeTime } from '@/lib/format'
import { type DiffLine, diffLines, diffSize } from './diff'
import type { RulesDraft } from './draft'

/** Where each version came from, in the page's words. */
export type OriginLabels = Readonly<Record<RulesOrigin, string>>

/** The versions of the rules in force, newest first. */
export type HistoryQuery<K extends QueryKey = QueryKey> = UseQueryOptions<
  RulesVersion[],
  Error,
  RulesVersion[],
  K
> & { queryKey: K }

interface Version {
  key: string
  label: string
  source: string
  time: string | undefined
  current: boolean
}

export function HistoryButton<K extends QueryKey>({
  draft,
  history,
  origins,
  open: controlled,
  onOpenChange,
}: {
  draft: RulesDraft
  history: HistoryQuery<K>
  origins: OriginLabels
  /** Open from elsewhere too (⌘K): the page holds whether the dialog is open. */
  open?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
}) {
  const [own, setOwn] = useState(false)
  const open = controlled ?? own
  const setOpen = (next: boolean) => {
    setOwn(next)
    onOpenChange?.(next)
  }
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
      {open && (
        <HistoryDialog
          draft={draft}
          history={history}
          origins={origins}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

export function HistoryDialog<K extends QueryKey>({
  draft,
  history: historyOptions,
  origins,
  onClose,
}: {
  draft: RulesDraft
  history: HistoryQuery<K>
  origins: OriginLabels
  onClose: () => void
}) {
  const history = useQuery(historyOptions)
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
      label: origins[version.origin] ?? version.origin,
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
