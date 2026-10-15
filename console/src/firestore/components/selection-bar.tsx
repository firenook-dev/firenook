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
//
// The bar itself is the kit's (`components/console/selection-bar.tsx`); this
// file gives it the documents' count and Firestore's own Copy, Export and
// Delete.

import { Button, DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import { CaretDownIcon, DownloadSimpleIcon, TrashIcon } from '@phosphor-icons/react'
import { useInfiniteQuery, useMutation } from '@tanstack/react-query'
import { SelectionBar as KitSelectionBar } from '@/components/console/selection-bar'
import { CopyGlyph, useCopied } from '@/components/kit'
import { copyToClipboard } from '@/lib/copy'
import { type ExportFormat, renderExport, useExportDialog } from '../export'
import { isEmptyQuery } from '../query'
import { pageQueryOptions } from '../queries'
import { useSelection } from '../selection'
import { formatNumber } from '../value'
import type { DeleteTarget } from './delete-dialog'
import { useMatchCount } from './query-line'
import { useWorkbench } from './workbench-context'

const DOCUMENTS = { one: 'document', other: 'documents' }

export function SelectionBar({ onDelete }: { onDelete: (target: DeleteTarget) => void }) {
  const workbench = useWorkbench()
  const toasts = useKumoToastManager()
  // The Copy button's own tick; the toast says how many and in what form.
  const tick = useCopied()
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
      return copyToClipboard(parts.join(''), {
        title: `Copied ${formatNumber(copied)} ${copied === 1 ? 'document' : 'documents'} as ${format === 'csv' ? 'CSV' : 'JSON'}`,
      })
    },
    onSuccess: (written) => {
      if (written) tick.flash()
    },
    onError: (failure) =>
      toasts.add({ title: 'Not copied', description: failure.message, variant: 'error' }),
  })

  return (
    <KitSelectionBar
      count={count}
      total={total ? { count: total.count, exact: true } : undefined}
      everything={everything}
      filtered={!isEmptyQuery(workbench.query)}
      noun={DOCUMENTS}
      onSelectEverything={() =>
        selectEverything(
          (page.data?.pages ?? []).flatMap((item) => item.documents.map((doc) => doc.path)),
        )
      }
      onClear={clear}
      actions={
        <>
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<CopyGlyph copied={tick.copied} />}
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
                  everything
                    ? { kind: 'everything', count }
                    : { kind: 'paths', paths: [...checked] },
                )
              }
              aria-label={`Delete ${formatNumber(count)} ${noun}`}
              data-testid="delete-selected"
            >
              Delete {formatNumber(count)}
            </Button>
          </span>
        </>
      }
    />
  )
}
