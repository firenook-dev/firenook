// Taking a list out of the emulator as a file, the same way everywhere:
// users, log lines, listings, documents. The dialog says what the file
// will hold — which rows, read as whom — before it writes anything.
//
// The engine streams the file when it can (`href`: its export route
// answers NDJSON or CSV as an attachment), and the browser's own download
// manager reads it, so nothing is assembled in this tab's memory. `run` is
// for the exports the browser must build itself, such as Firestore's
// view-as export, which reads through the rules as the chosen identity.

import { Button, Dialog, Tabs, Text } from '@cloudflare/kumo'
import { DownloadSimpleIcon, XIcon } from '@phosphor-icons/react'
import { type ReactNode, useRef, useState } from 'react'
import { download } from '@/lib/download'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'

export type ExportFormat = 'json' | 'ndjson' | 'csv'

export const EXPORT_FORMAT_INFO: Record<
  ExportFormat,
  { label: string; note: string; mediaType: string }
> = {
  json: {
    label: 'JSON',
    note: 'One JSON document holding every row.',
    mediaType: 'application/json',
  },
  ndjson: {
    label: 'NDJSON',
    note: 'One JSON value per line, for jq, BigQuery and streaming tools.',
    mediaType: 'application/x-ndjson',
  },
  csv: {
    label: 'CSV',
    note: 'Columns for a spreadsheet; nested values are written as JSON in their cell.',
    mediaType: 'text/csv',
  },
}

type Progress = { done: number; total: number | undefined } | null

export function ExportDialog({
  open,
  onOpenChange,
  title,
  scope,
  formats,
  filename,
  href,
  run,
  testId = 'export-dialog',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** What the file will contain, and whose view it is. */
  scope: ReactNode
  formats: readonly ExportFormat[]
  filename: (format: ExportFormat) => string
  /** Preferred: the engine streams the file, and the browser downloads it. */
  href?: (format: ExportFormat) => string
  /** Only for exports the browser must build. */
  run?: (
    format: ExportFormat,
    signal: AbortSignal,
    progress: (done: number, total?: number) => void,
  ) => Promise<Blob>
  testId?: string
}) {
  const [format, setFormat] = useState<ExportFormat>(formats[0] ?? 'json')
  const [progress, setProgress] = useState<Progress>(null)
  const [error, setError] = useState<string | undefined>()
  const abort = useRef<AbortController | null>(null)
  const chosen = formats.includes(format) ? format : (formats[0] ?? 'json')
  const info = EXPORT_FORMAT_INFO[chosen]
  const running = progress !== null

  const close = (next: boolean) => {
    if (!next) {
      abort.current?.abort()
      abort.current = null
      setProgress(null)
      setError(undefined)
    }
    onOpenChange(next)
  }

  const start = async () => {
    setError(undefined)
    const name = filename(chosen)
    if (href) {
      try {
        await download(href(chosen), name)
        toast({
          key: `export:${name}`,
          title: 'Export started',
          description: name,
          tone: 'success',
        })
        close(false)
      } catch (thrown) {
        setError(thrown instanceof Error ? thrown.message : String(thrown))
      }
      return
    }
    if (!run) return
    const controller = new AbortController()
    abort.current = controller
    setProgress({ done: 0, total: undefined })
    try {
      const blob = await run(chosen, controller.signal, (done, total) =>
        setProgress({ done, total }),
      )
      if (controller.signal.aborted) return
      await download(
        () => Promise.resolve(new Response(blob, { headers: { 'content-type': info.mediaType } })),
        name,
      )
      toast({ key: `export:${name}`, title: 'Exported', description: name, tone: 'success' })
      abort.current = null
      setProgress(null)
      onOpenChange(false)
    } catch (thrown) {
      if (controller.signal.aborted) return
      setError(thrown instanceof Error ? thrown.message : String(thrown))
      setProgress(null)
    } finally {
      if (abort.current === controller) abort.current = null
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog size="lg" className="p-6">
        {/* Kumo's Dialog drops a test id; the contents carry it. */}
        <div className="contents" data-testid={testId}>
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="text-kumo-subtle" data-testid={`${testId}-scope`}>
            {scope}
          </Dialog.Description>
          <div className="mt-4 grid gap-2">
            {formats.length > 1 && (
              <Tabs
                size="sm"
                variant="segmented"
                value={chosen}
                onValueChange={(value) => setFormat(value as ExportFormat)}
                tabs={formats.map((item) => ({
                  value: item,
                  label: EXPORT_FORMAT_INFO[item].label,
                }))}
              />
            )}
            <Text variant="secondary" size="sm">
              {info.note}
            </Text>
          </div>
          {progress && (
            <div className="mt-3" data-testid={`${testId}-progress`}>
              <Text variant="secondary" size="sm">
                {progress.total === undefined
                  ? `Read ${formatNumber(progress.done)}…`
                  : `Read ${formatNumber(progress.done)} of ${formatNumber(progress.total)}…`}
              </Text>
            </div>
          )}
          {error && (
            <div className="mt-2" data-testid={`${testId}-error`}>
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
              onClick={() => void start()}
              loading={running}
              data-testid={`${testId}-confirm`}
            >
              Export {info.label}
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
