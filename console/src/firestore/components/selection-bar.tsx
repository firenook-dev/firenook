// What you can do with the rows you ticked, in the place the query line
// was.
//
// It used to be spread over three places: Delete in the toolbar two rows
// up, beside the identity picker; Export and the count in the footer at
// the bottom of the screen; and nothing at all for "every document, not
// just the loaded ones". A selection is a mode, and while it is on the
// query line is the thing least worth reading — so the bar takes its
// place, at its height, and the rows below do not move: a shift-click
// aimed at the next row still lands on it.

import { Button, DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import {
  CaretDownIcon,
  CopyIcon,
  DownloadSimpleIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useInfiniteQuery, useMutation } from '@tanstack/react-query'
import { type ExportFormat, renderExport, useExportDialog } from '../export'
import { isEmptyQuery } from '../query'
import { pageQueryOptions } from '../queries'
import { useSelection } from '../selection'
import { formatNumber } from '../value'
import type { DeleteTarget } from './delete-dialog'
import { useMatchCount } from './query-line'
import { useWorkbench } from './workbench-context'

export function SelectionBar({ onDelete }: { onDelete: (target: DeleteTarget) => void }) {
  const workbench = useWorkbench()
  const toasts = useKumoToastManager()
  const checked = useSelection((state) => state.checked)
  const everything = useSelection((state) => state.everything)
  const clear = useSelection((state) => state.clear)
  const selectEverything = useSelection((state) => state.selectEverything)
  const openExport = useExportDialog((state) => state.setOpen)
  const { total } = useMatchCount()
  // The grid's own page query, for the rows to show ticked: same key, same
  // cache, no second request.
  const page = useInfiniteQuery({
    ...pageQueryOptions(
      workbench.scope,
      workbench.collectionPath,
      workbench.group,
      workbench.query,
    ),
    enabled: false,
  })

  const count = everything ? (total?.count ?? checked.size) : checked.size
  const more = !everything && total !== undefined && total.count > checked.size
  const noun = count === 1 ? 'document' : 'documents'

  const copy = useMutation({
    mutationFn: async (format: ExportFormat) => {
      const { parts, count: copied } = await renderExport(
        {
          scope: workbench.scope,
          collectionPath: workbench.collectionPath,
          group: workbench.group,
          query: workbench.query,
          only: everything ? undefined : [...checked],
        },
        { format, typed: false },
      )
      await navigator.clipboard.writeText(parts.join(''))
      return { copied, format }
    },
    onSuccess: ({ copied, format }) =>
      toasts.add({
        title: `Copied ${formatNumber(copied)} ${copied === 1 ? 'document' : 'documents'} as ${format === 'csv' ? 'CSV' : 'JSON'}`,
      }),
    onError: (failure) =>
      toasts.add({ title: 'Not copied', description: failure.message, variant: 'error' }),
  })

  return (
    <div
      className="absolute inset-0 z-10 flex items-center gap-2 overflow-x-auto border-b border-kumo-line bg-kumo-base px-3 whitespace-nowrap"
      role="toolbar"
      aria-label="Selected documents"
      data-testid="selection-bar"
    >
      <span className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<XIcon />}
          onClick={clear}
          aria-label="Clear the selection"
          data-testid="clear-selection"
        />
        <span className="text-[13px] text-kumo-default" data-testid="selection-count">
          {everything ? 'All ' : ''}
          <span className="font-mono tabular-nums">{formatNumber(count)}</span> selected
        </span>
      </span>
      {/* Every document, not only the loaded hundred. Named with what it
          reaches, because a filter is easy to forget while the line that
          shows it is covered by this bar. */}
      {more && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            selectEverything(
              (page.data?.pages ?? []).flatMap((item) => item.documents.map((doc) => doc.path)),
            )
          }
          data-testid="select-everything"
        >
          Select all {formatNumber(total.count)}
          {isEmptyQuery(workbench.query) ? '' : ' matching'}
        </Button>
      )}
      <span className="mx-1 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              icon={<CopyIcon />}
              loading={copy.isPending}
              data-testid="copy-selection"
            >
              Copy
              <CaretDownIcon size={12} className="text-kumo-subtle" />
            </Button>
          }
        />
        <DropdownMenu.Content align="start">
          <DropdownMenu.Item onClick={() => copy.mutate('json')} data-testid="copy-json">
            As JSON, keyed by id
          </DropdownMenu.Item>
          <DropdownMenu.Item onClick={() => copy.mutate('csv')} data-testid="copy-csv">
            As CSV
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="sm"
        icon={<DownloadSimpleIcon />}
        onClick={() => openExport(true)}
        data-testid="export-open"
      >
        Export
      </Button>
      <span className="ml-auto shrink-0 pl-3">
        <Button
          variant="secondary-destructive"
          size="sm"
          icon={<TrashIcon />}
          onClick={() =>
            onDelete(
              everything ? { kind: 'everything', count } : { kind: 'paths', paths: [...checked] },
            )
          }
          aria-label={`Delete ${formatNumber(count)} ${noun}`}
          data-testid="delete-selected"
        >
          Delete {formatNumber(count)}
        </Button>
      </span>
    </div>
  )
}
