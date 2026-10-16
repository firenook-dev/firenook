// The Pub/Sub setup as a file (S16, PS-90, PS-91). Pub/Sub keeps nothing
// across a restart, so the topics, subscriptions and schemas a project
// needs go out as one JSON file — every schema revision in order, never a
// message, never what the functions create for themselves — and come back
// in after the next start, in dependency order, each revision replayed and
// each topic's schema binding moved to the revision ids the engine gives
// the replay. What the import will do is listed before anything is created
// (create, exists, left out), and the engine's answer after (created,
// skipped with its reason, the revision ids it mapped).

import { Button, Checkbox, Dialog, Tabs, Text, Tooltip, cn } from '@cloudflare/kumo'
import {
  BroadcastIcon,
  CopyIcon,
  DownloadSimpleIcon,
  FileArrowUpIcon,
  type Icon,
  TableIcon,
  TrayArrowDownIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useRef, useState } from 'react'
import type { PubsubSetup } from '@/api/generated/messaging/PubsubSetup'
import type { PubsubSetupResult } from '@/api/generated/messaging/PubsubSetupResult'
import type { PubsubTopicIndex } from '@/api/generated/messaging/PubsubTopicIndex'
import { copyToClipboard } from '@/lib/copy'
import { download } from '@/lib/download'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { errorText } from '@/lib/error-text'
import { importSetup } from '../api'
import { shortName } from '../names'
import { pubsubKeys, schemasQuery, setupQuery, topicIndexQuery } from '../queries'
import {
  type ImportItem,
  type ImportStatus,
  SETUP_FILENAME,
  countsText,
  existingFrom,
  exportLeftOut,
  importPreview,
  importable,
  moveProject,
  parseSetup,
  previewCounts,
  resultText,
  setupCounts,
  setupProjects,
} from '../setup'
import { useGeneration } from './create-topic-dialog'

export type SetupTab = 'export' | 'import'

/** The setup as the file holds it: indented, so it reads (and diffs) well where it is kept. */
export function setupText(setup: PubsubSetup): string {
  return `${JSON.stringify(setup, null, 2)}\n`
}

export function SetupDialog({
  open,
  onOpenChange,
  project,
  index,
  tab,
  onTab,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The project the page shows: what is exported, and where an import goes. */
  project: string
  index: PubsubTopicIndex | undefined
  tab: SetupTab
  onTab: (tab: SetupTab) => void
}) {
  const generation = useGeneration(open)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6">
        <div className="grid gap-4" data-testid="pubsub-setup">
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Pub/Sub setup</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
            />
          </div>
          <Dialog.Description className="-mt-2 text-kumo-subtle">
            Topics, subscriptions and schemas as one file, never messages. Pub/Sub keeps nothing
            across a restart: import the file after the next start to get them back.
          </Dialog.Description>
          <Tabs
            variant="segmented"
            size="sm"
            value={tab}
            onValueChange={(next) => onTab(next as SetupTab)}
            tabs={[
              {
                value: 'export',
                label: <span data-testid="pubsub-setup-tab-export">Export</span>,
              },
              {
                value: 'import',
                label: <span data-testid="pubsub-setup-tab-import">Import</span>,
              },
            ]}
          />
          {tab === 'export' ? (
            <ExportPanel
              open={open}
              project={project}
              index={index}
              onClose={() => onOpenChange(false)}
            />
          ) : (
            // A fresh import on each open: the last file's preview is not
            // the next one's.
            <ImportPanel key={generation} project={project} onClose={() => onOpenChange(false)} />
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

// ------------------------------------------------------------ export

function ExportPanel({
  open,
  project,
  index,
  onClose,
}: {
  open: boolean
  project: string
  index: PubsubTopicIndex | undefined
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  // Read whenever the panel is shown: the setup changes as the app runs.
  const setup = useQuery({ ...setupQuery(project), enabled: open && project !== '', staleTime: 0 })
  const counts = setup.data ? setupCounts(setup.data) : undefined
  const leftOut = exportLeftOut(index)
  const empty = counts !== undefined && counts.topics + counts.subscriptions + counts.schemas === 0
  const [error, setError] = useState<string | undefined>(undefined)

  /** The setup as it is now, read again so the file is what the engine holds this moment. */
  const fresh = async () => {
    const value = await queryClient.fetchQuery({ ...setupQuery(project), staleTime: 0 })
    return setupText(value)
  }
  const save = async () => {
    setError(undefined)
    try {
      const url = URL.createObjectURL(new Blob([await fresh()], { type: 'application/json' }))
      try {
        await download(url, SETUP_FILENAME)
      } finally {
        // The click has started the download; the browser reads the URL before the next task.
        setTimeout(() => URL.revokeObjectURL(url), 0)
      }
      toast({
        key: 'pubsub-setup-export',
        title: 'Exported the Pub/Sub setup',
        description: SETUP_FILENAME,
        tone: 'success',
      })
      onClose()
    } catch (thrown) {
      setError(errorText(thrown))
    }
  }
  const copy = async () => {
    setError(undefined)
    try {
      const text = await fresh()
      await copyToClipboard(text, {
        what: 'the Pub/Sub setup as JSON',
        key: 'pubsub-setup-export',
      })
    } catch (thrown) {
      setError(errorText(thrown))
    }
  }

  return (
    <>
      <div
        className="grid gap-1.5 rounded-lg px-4 py-3 ring ring-kumo-line"
        data-testid="pubsub-setup-export"
      >
        {setup.isError ? (
          <Text variant="error" size="sm">
            {errorText(setup.error)}
          </Text>
        ) : (
          <>
            <p className="m-0 text-[14px] text-kumo-default" data-testid="pubsub-setup-counts">
              {counts === undefined ? (
                <span className="text-kumo-subtle">Reading the setup…</span>
              ) : empty ? (
                <>
                  Nothing to export from <span className="font-mono text-[0.9em]">{project}</span>{' '}
                  yet.
                </>
              ) : (
                <>
                  {countsText(counts)} of <span className="font-mono text-[0.9em]">{project}</span>.
                </>
              )}
            </p>
            {leftOut.length > 0 && (
              <Tooltip
                content={
                  <span className="grid gap-0.5">
                    {leftOut.map((item) => (
                      <span key={item.name} className="font-mono text-[11px]">
                        {shortName(item.name)}
                      </span>
                    ))}
                  </span>
                }
                render={
                  <p
                    className="m-0 w-fit text-[13px] text-kumo-subtle"
                    data-testid="pubsub-setup-left-out"
                  >
                    {formatNumber(leftOut.length)} function-managed{' '}
                    {leftOut.length === 1 ? 'resource' : 'resources'} left out: the functions create
                    them again.
                  </p>
                }
              />
            )}
            <p className="m-0 text-[12px] text-kumo-subtle">
              JSON, indented, every schema revision in order: the file Import reads back.
            </p>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          {error && (
            <span className="text-[13px] text-kumo-danger" data-testid="pubsub-setup-error">
              {error}
            </span>
          )}
        </span>
        <Button
          variant="secondary"
          icon={<CopyIcon />}
          disabled={counts === undefined || empty}
          onClick={() => void copy()}
          data-testid="pubsub-setup-copy"
        >
          Copy
        </Button>
        <Button
          variant="primary"
          icon={<DownloadSimpleIcon />}
          disabled={counts === undefined || empty}
          onClick={() => void save()}
          data-testid="pubsub-setup-download"
        >
          Download {SETUP_FILENAME}
        </Button>
      </div>
    </>
  )
}

// ------------------------------------------------------------ import

type Read = { name: string; text: string } | null

function ImportPanel({ project, onClose }: { project: string; onClose: () => void }) {
  const [file, setFile] = useState<Read>(null)
  const [result, setResult] = useState<PubsubSetupResult | null>(null)
  if (result)
    return (
      <ImportResult
        result={result}
        onAgain={() => {
          setResult(null)
          setFile(null)
        }}
        onClose={onClose}
      />
    )
  if (!file) return <DropZone onFile={setFile} onClose={onClose} />
  return (
    <ImportPreview
      project={project}
      file={file}
      onOther={() => setFile(null)}
      onDone={setResult}
      onClose={onClose}
    />
  )
}

/** Where a file is dropped or chosen. */
function DropZone({
  onFile,
  onClose,
}: {
  onFile: (file: { name: string; text: string }) => void
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const read = (picked: File | undefined) => {
    if (!picked) return
    void picked.text().then((text) => onFile({ name: picked.name, text }))
  }
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        data-testid="pubsub-setup-file"
        onChange={(event) => {
          const picked = event.target.files?.[0]
          event.target.value = ''
          read(picked)
        }}
      />
      <div
        className={cn(
          'grid justify-items-center gap-2 rounded-lg border border-dashed border-kumo-line px-6 py-8 text-center',
          over && 'bg-kumo-tint',
        )}
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          read(event.dataTransfer.files[0])
        }}
        data-testid="pubsub-setup-drop"
      >
        <FileArrowUpIcon size={22} className="text-kumo-subtle" />
        <p className="m-0 text-[14px] text-kumo-default">Drop a setup file here</p>
        <p className="m-0 text-[13px] text-kumo-subtle">
          The {SETUP_FILENAME} the Export tab writes. Nothing is created until you say so.
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-1"
          onClick={() => input.current?.click()}
          data-testid="pubsub-setup-choose"
        >
          Choose a file…
        </Button>
      </div>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </>
  )
}

const STATUS_TITLE: Record<ImportStatus, string> = {
  create: 'To create',
  exists: 'Already there, skipped',
  'left-out': 'Left out',
}

const KIND_ICON: Record<ImportItem['kind'], Icon> = {
  schema: TableIcon,
  topic: BroadcastIcon,
  subscription: TrayArrowDownIcon,
}

function ImportPreview({
  project,
  file,
  onOther,
  onDone,
  onClose,
}: {
  project: string
  file: { name: string; text: string }
  onOther: () => void
  onDone: (result: PubsubSetupResult) => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const parsed = parseSetup(file.text)
  const [move, setMove] = useState(true)
  const original = parsed.ok ? parsed.setup : undefined
  const foreign = original !== undefined && original.project !== project
  const setup = original && foreign && move ? moveProject(original, project) : original
  // What exists already, in every project the file names.
  // (A name under an empty project segment has no project to ask about.)
  const projects = setup ? setupProjects(setup).filter((name) => name !== '') : []
  const indexes = useQueries({ queries: projects.map((name) => topicIndexQuery(name)) })
  const schemaLists = useQueries({ queries: projects.map((name) => schemasQuery(name)) })
  const known =
    indexes.every((query) => query.data !== undefined || query.isError) &&
    schemaLists.every((query) => query.data !== undefined || query.isError)
  const items =
    setup && known
      ? importPreview(
          setup,
          existingFrom(
            indexes.map((query) => query.data),
            schemaLists.map((query) => query.data?.items),
          ),
        )
      : []
  const counts = previewCounts(items)

  const run = useMutation({
    mutationFn: (value: PubsubSetup) => importSetup(importable(value)),
    onSuccess: (answer) => {
      // The page's own project follows by its counters topic; the others named here are read again.
      for (const name of new Set([project, ...projects]))
        void queryClient.invalidateQueries({ queryKey: pubsubKeys.section(name) })
      onDone(answer)
    },
  })

  if (!parsed.ok)
    return (
      <>
        <div
          className="grid gap-1 rounded-lg px-4 py-3 ring ring-kumo-danger"
          data-testid="pubsub-setup-invalid"
        >
          <p className="m-0 font-mono text-[12px] text-kumo-subtle">{file.name}</p>
          <p className="m-0 text-[13px] text-kumo-danger">{parsed.message}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onOther} data-testid="pubsub-setup-other">
            Choose another file
          </Button>
        </div>
      </>
    )

  const groups = (['create', 'exists', 'left-out'] as const).filter((status) => counts[status] > 0)
  return (
    <>
      <div className="grid gap-1">
        <p className="m-0 text-[13px] text-kumo-default" data-testid="pubsub-setup-file-summary">
          <span className="font-mono text-[12px]">{file.name}</span>
          <span className="text-kumo-subtle">
            {' '}
            · {setup ? countsText(setupCounts(setup)) : ''} from{' '}
            <span className="font-mono text-[12px]">{original?.project}</span>
          </span>
        </p>
        {foreign && (
          <Checkbox
            checked={move}
            onCheckedChange={(checked) => setMove(Boolean(checked))}
            label={
              <span className="text-[13px]">
                Create them in <span className="font-mono text-[0.9em]">{project}</span>, the
                project shown here
              </span>
            }
            data-testid="pubsub-setup-move"
          />
        )}
      </div>
      <div
        className="grid max-h-72 gap-3 overflow-y-auto rounded-lg px-4 py-3 ring ring-kumo-line"
        data-testid="pubsub-setup-preview"
      >
        {!known ? (
          <p className="m-0 text-[13px] text-kumo-subtle">Reading what the emulator has…</p>
        ) : items.length === 0 ? (
          <p className="m-0 text-[13px] text-kumo-subtle">The file holds nothing to create.</p>
        ) : (
          groups.map((status) => (
            <section key={status} className="grid gap-1" aria-label={STATUS_TITLE[status]}>
              <h3 className="m-0 text-[12px] font-normal text-kumo-subtle">
                {STATUS_TITLE[status]} · {formatNumber(counts[status])}
              </h3>
              <ul className="m-0 grid list-none gap-1 p-0">
                {items
                  .filter((item) => item.status === status)
                  .map((item) => (
                    <PreviewRow key={`${item.kind}:${item.name}`} item={item} />
                  ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          {run.isError ? (
            <span className="text-[13px] text-kumo-danger" data-testid="pubsub-setup-error">
              {errorText(run.error)}
            </span>
          ) : (
            <Button variant="ghost" size="sm" onClick={onOther}>
              Choose another file
            </Button>
          )}
        </span>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={counts.create > 0 ? 'primary' : 'secondary'}
          disabled={!known || counts.create === 0 || !setup}
          loading={run.isPending}
          onClick={() => setup && run.mutate(setup)}
          data-testid="pubsub-setup-create"
        >
          Create {formatNumber(counts.create)}
        </Button>
      </div>
    </>
  )
}

function PreviewRow({ item }: { item: ImportItem }) {
  const Glyph = KIND_ICON[item.kind]
  const note = item.warning ?? item.reason
  return (
    <li
      className="grid gap-0.5"
      data-testid="pubsub-setup-item"
      data-status={item.status}
      data-name={item.name}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Glyph size={13} className="shrink-0 text-kumo-subtle" />
        <Tooltip
          content={item.name}
          render={
            <span
              className={cn(
                'min-w-0 truncate font-mono text-[12px]',
                item.status === 'create' ? 'text-kumo-default' : 'text-kumo-subtle',
              )}
            >
              {shortName(item.name)}
            </span>
          }
        />
        {item.detail && (
          <span className="min-w-0 truncate text-[12px] text-kumo-subtle">{item.detail}</span>
        )}
      </span>
      {note && (
        <span
          className={cn(
            'flex items-start gap-1 pl-5 text-[12px]',
            item.warning ? 'text-kumo-warning' : 'text-kumo-subtle',
          )}
        >
          {item.warning && <WarningIcon size={12} className="mt-0.5 shrink-0" />}
          {note}
        </span>
      )}
    </li>
  )
}

function ImportResult({
  result,
  onAgain,
  onClose,
}: {
  result: PubsubSetupResult
  onAgain: () => void
  onClose: () => void
}) {
  return (
    <>
      <div
        className="grid max-h-80 gap-3 overflow-y-auto rounded-lg px-4 py-3 ring ring-kumo-line"
        data-testid="pubsub-setup-result"
      >
        <p className="m-0 text-[14px] text-kumo-default">{resultText(result)}</p>
        {result.created.length > 0 && (
          <ResultList title="Created" count={result.created.length}>
            {result.created.map((name) => (
              <li key={name} className="truncate font-mono text-[12px] text-kumo-default">
                <Tooltip content={name} render={<span>{shortName(name)}</span>} />
              </li>
            ))}
          </ResultList>
        )}
        {result.skipped.length > 0 && (
          <ResultList title="Skipped" count={result.skipped.length}>
            {result.skipped.map((skip) => (
              <li key={skip.name} className="grid gap-0.5" data-testid="pubsub-setup-skipped">
                <span className="truncate font-mono text-[12px] text-kumo-default">
                  {shortName(skip.name)}
                </span>
                <span className="text-[12px] text-kumo-subtle">{skip.reason}</span>
              </li>
            ))}
          </ResultList>
        )}
        {result.revisions.length > 0 && (
          <ResultList title="Revision ids" count={result.revisions.length}>
            {result.revisions.map((mapping) => (
              <li
                key={`${mapping.schema}:${mapping.exported}`}
                className="flex items-center gap-2 font-mono text-[12px]"
                data-testid="pubsub-setup-mapping"
              >
                <span className="min-w-0 truncate text-kumo-subtle">
                  {shortName(mapping.schema)}
                </span>
                <span className="text-kumo-subtle">{mapping.exported}</span>
                <span aria-hidden className="text-kumo-subtle">
                  →
                </span>
                <span className="sr-only">became</span>
                <span className="text-kumo-default">{mapping.created}</span>
              </li>
            ))}
          </ResultList>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onAgain}>
          Import another
        </Button>
        <Button variant="primary" onClick={onClose} data-testid="pubsub-setup-done">
          Done
        </Button>
      </div>
    </>
  )
}

function ResultList({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="grid gap-1" aria-label={title}>
      <h3 className="m-0 text-[12px] font-normal text-kumo-subtle">
        {title} · {formatNumber(count)}
      </h3>
      <ul className="m-0 grid list-none gap-1 p-0">{children}</ul>
    </section>
  )
}
