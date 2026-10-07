// Taking the page you are looking at out of the emulator.
//
// The dialog says exactly what will be written before it writes anything:
// which documents, in which shape, and under whose identity — an export made
// while viewing as a user contains what that user can read. It pages through
// the whole result with the grid's own cursors and reads whole documents,
// never the previews a cell draws from.

import { Button, Checkbox, Dialog, Tabs, Text, useKumoToastManager } from '@cloudflare/kumo'
import { DownloadSimpleIcon, XIcon } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import {
  EXPORT_FORMATS,
  type ExportFormat,
  type ExportOptions,
  csvCell,
  csvColumns,
  csvRow,
  documentToJson,
  download,
  exportFilename,
  exportPages,
  formatInfo,
} from '../export'
import { printQuery } from '../query'
import { documentRoot } from '../rest'
import { useSelection } from '../selection'
import { fieldsToJson, formatNumber } from '../value'
import { useWorkbench } from './workbench-context'

type Progress = { documents: number; done: boolean } | null

export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const workbench = useWorkbench()
  const toasts = useKumoToastManager()
  const checked = useSelection((state) => state.checked)
  const [format, setFormat] = useState<ExportFormat>('json')
  const [typed, setTyped] = useState(false)
  const [progress, setProgress] = useState<Progress>(null)
  const [error, setError] = useState<string | undefined>()
  const abort = useRef<AbortController | null>(null)

  const selected = [...checked]
  const only = selected.length > 0 ? selected : undefined
  const info = formatInfo(format)
  const running = progress !== null && !progress.done

  const close = (next: boolean) => {
    if (!next) {
      abort.current?.abort()
      abort.current = null
      setProgress(null)
      setError(undefined)
    }
    onOpenChange(next)
  }

  const run = async () => {
    const controller = new AbortController()
    abort.current = controller
    setError(undefined)
    setProgress({ documents: 0, done: false })
    const options: ExportOptions = { format, typed }
    const root = documentRoot(workbench.scope)
    // Parts, not one growing string: a large collection would otherwise be
    // held twice over while the file is assembled.
    const parts: string[] = []
    let count = 0
    try {
      if (format === 'csv') {
        // A CSV needs its columns before its first row, and the rows are
        // only known as they arrive, so the whole set is collected first.
        const all = []
        for await (const batch of exportPages(
          {
            scope: workbench.scope,
            collectionPath: workbench.collectionPath,
            group: workbench.group,
            query: workbench.query,
            only,
          },
          controller.signal,
        )) {
          all.push(...batch)
          count += batch.length
          setProgress({ documents: count, done: false })
        }
        const columns = csvColumns(all)
        parts.push(csvRow(['__id__', ...columns]))
        for (const item of all) {
          const fields = fieldsToJson(item.fields)
          parts.push(csvRow([item.id, ...columns.map((column) => csvCell(fields, column))]))
        }
      } else {
        if (format === 'json') parts.push('{\n')
        let first = true
        for await (const batch of exportPages(
          {
            scope: workbench.scope,
            collectionPath: workbench.collectionPath,
            group: workbench.group,
            query: workbench.query,
            only,
          },
          controller.signal,
        )) {
          for (const item of batch) {
            const body = JSON.stringify(documentToJson(item, options, root))
            if (format === 'json') {
              parts.push(`${first ? '' : ',\n'}  ${JSON.stringify(item.id)}: ${body}`)
            } else {
              parts.push(`${body}\n`)
            }
            first = false
          }
          count += batch.length
          setProgress({ documents: count, done: false })
        }
        if (format === 'json') parts.push('\n}\n')
      }
      if (controller.signal.aborted) return
      download(
        new Blob(parts, { type: info.mediaType }),
        exportFilename(workbench.collectionPath, format),
      )
      setProgress({ documents: count, done: true })
      toasts.add({
        title: `Exported ${formatNumber(count)} ${count === 1 ? 'document' : 'documents'}`,
        description: exportFilename(workbench.collectionPath, format),
        variant: 'success',
      })
      onOpenChange(false)
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
      setProgress(null)
    } finally {
      abort.current = null
    }
  }

  const what = only
    ? `${formatNumber(only.length)} selected ${only.length === 1 ? 'document' : 'documents'}`
    : workbench.query.where.length > 0 || workbench.query.orderBy.length > 0
      ? `every document matching ${printQuery(workbench.query)}`
      : `every document in ${workbench.collectionPath}`

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog size="lg" className="p-6">
        <div className="mb-3 flex items-start justify-between gap-4">
          <Dialog.Title className="text-lg font-semibold">Export</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
          />
        </div>
        <Dialog.Description className="text-kumo-subtle">
          <span data-testid="export-scope">{what}</span>, read whole — not the shortened values the
          grid draws.{' '}
          {workbench.scope.authorization?.startsWith('Bearer owner')
            ? 'Rules are bypassed, so this is everything the engine holds.'
            : 'Security rules apply, so this is what the identity you are viewing as can read.'}
        </Dialog.Description>

        <div className="mt-4 grid gap-3">
          <Tabs
            size="sm"
            variant="segmented"
            value={format}
            onValueChange={(value) => setFormat(value as ExportFormat)}
            tabs={EXPORT_FORMATS.map((item) => ({ value: item.id, label: item.label }))}
          />
          <Text variant="secondary" size="sm">
            {info.note}
          </Text>
          {format !== 'csv' && (
            <div className="grid gap-1">
              <Checkbox
                checked={typed}
                onCheckedChange={(value) => setTyped(Boolean(value))}
                label="Keep Firestore types exactly"
              />
              <span className="pl-6">
                <Text variant="secondary" size="sm">
                  The REST wire shape. References, bytes, geopoints and vectors have no plain-JSON
                  form that survives a round trip.
                </Text>
              </span>
            </div>
          )}
        </div>

        {progress && !progress.done && (
          <div className="mt-3" data-testid="export-progress">
            <Text variant="secondary" size="sm">
              Read {formatNumber(progress.documents)}…
            </Text>
          </div>
        )}
        {error && (
          <div className="mt-2">
            <Text variant="error" size="sm">
              {error}
            </Text>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => close(false)}>
            {running ? 'Stop' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            icon={<DownloadSimpleIcon />}
            onClick={() => void run()}
            loading={running}
            data-testid="confirm-export"
          >
            Export {info.label}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
