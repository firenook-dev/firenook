// The pieces every Run form shares: its footer (tools left, the one primary
// right), Copy as (curl, fetch, the CLI), the saved tests menu, the paused
// warning a test event shows before it is sent, a labelled row, and the
// answer — the invocation it made, how it ended, and its own log lines,
// live while it runs.

import { Button, DropdownMenu, Text, Tooltip } from '@cloudflare/kumo'
import {
  CaretDownIcon,
  CopyIcon,
  DownloadSimpleIcon,
  FloppyDiskIcon,
  TrashIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { apiSend } from '@/api/client'
import type { FunctionLogLine } from '@/api/generated/compute/FunctionLogLine'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { statusQuery } from '@/api/queries'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { DurationText } from '@/compute/duration-text'
import { formatNumber } from '@/lib/format'
import { createFeedStore } from '@/lib/live/feed-store'
import { useLiveTopic } from '@/lib/live/use-live-topic'
import { toast } from '@/lib/toasts'
import { invocationQuery } from '../api'
import { useInvocationLive } from '../live'
import {
  type SavedKind,
  type SavedTest,
  deleteTest,
  exportTests,
  importTests,
  saveTest,
  useSavedTests,
} from '../saved-tests'
import { copyText } from '../use-functions'
import { LogLines, lineKey } from './log-lines'

/** A labelled row of a Run form: the label 12 px quiet, the control beside it. */
export function FormRow({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="grid gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-[76px] shrink-0 text-[12px] text-kumo-subtle">{label}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
      </div>
      {hint && <div className="pl-[84px] text-[11px] text-kumo-subtle">{hint}</div>}
    </div>
  )
}

/** The form's foot: tools on the left, the one primary action on the right. */
export function RunFooter({ tools, primary }: { tools?: ReactNode; primary: ReactNode }) {
  return (
    <footer
      className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-1 gap-y-1.5 border-t border-kumo-line px-5 py-2"
      data-testid="run-footer"
    >
      <div className="flex min-w-0 items-center gap-1">{tools}</div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{primary}</div>
    </footer>
  )
}

/** One dialect of Copy as: its text, or why this request cannot be said that way. */
export interface CopyDialect {
  id: string
  label: string
  text?: string | undefined
  refused?: string | undefined
}

/** "Copy as ▾": curl, fetch and the CLI command carrying this request's own data. */
export function CopyAsMenu({
  dialects,
  testId = 'run-copy-as',
}: {
  dialects: readonly CopyDialect[]
  testId?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="ghost" size="sm" icon={<CopyIcon />} data-testid={testId}>
            <span className="flex items-center gap-1">
              Copy as
              <CaretDownIcon size={12} className="text-kumo-subtle" />
            </span>
          </Button>
        }
      />
      <DropdownMenu.Content align="start">
        {dialects.map((dialect) => {
          const item = (
            <DropdownMenu.Item
              key={dialect.id}
              disabled={dialect.text === undefined}
              onClick={() => {
                if (dialect.text !== undefined)
                  void copyText(dialect.text, `the ${dialect.label} command`)
              }}
              data-testid={`${testId}-${dialect.id}`}
            >
              <span className="font-mono text-[12px]">{dialect.label}</span>
            </DropdownMenu.Item>
          )
          return dialect.refused ? (
            <Tooltip
              key={dialect.id}
              content={dialect.refused}
              side="right"
              render={<span className="block">{item}</span>}
            />
          ) : (
            item
          )
        })}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/** "Saved ▾" and "Save as…": the function's saved tests, export and import. */
export function SavedMenu({
  project,
  functionId,
  kind,
  current,
  onLoad,
}: {
  project: string
  functionId: string
  kind: SavedKind
  /** The draft to save as it stands. */
  current: () => SavedTest['draft']
  onLoad: (test: SavedTest) => void
}) {
  const saved = useSavedTests(project, functionId).filter((test) => test.kind === kind)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const save = () => {
    const result = saveTest(project, functionId, { name, kind, draft: current() })
    if ('refused' in result) {
      toast({
        key: 'functions.saved-tests',
        title: 'Could not save the test',
        description: result.refused,
        tone: 'warning',
        action:
          saved.length > 0
            ? { label: 'Export', run: () => exportFile(functionId, saved) }
            : undefined,
      })
      return
    }
    toast({ key: 'functions.saved-tests', title: `Saved ${name.trim()}`, tone: 'success' })
    setNaming(false)
    setName('')
  }
  useEffect(() => {
    if (naming) input.current?.focus()
  }, [naming])
  if (naming)
    return (
      <span className="flex items-center gap-1">
        <input
          ref={input}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              save()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setNaming(false)
            }
          }}
          placeholder="Name this test"
          aria-label="Name of the saved test"
          className="h-7 w-36 rounded-md bg-kumo-control px-2 text-[12px] ring ring-kumo-line outline-none placeholder:text-kumo-inactive focus:ring-kumo-focus"
          data-testid="saved-name"
        />
        <Button
          variant="secondary"
          size="sm"
          icon={<FloppyDiskIcon />}
          onClick={save}
          data-testid="saved-save"
        >
          Save
        </Button>
      </span>
    )
  return (
    <>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button variant="ghost" size="sm" data-testid="saved-menu">
              <span className="flex items-center gap-1">
                Saved{saved.length > 0 ? ` · ${formatNumber(saved.length)}` : ''}
                <CaretDownIcon size={12} className="text-kumo-subtle" />
              </span>
            </Button>
          }
        />
        <DropdownMenu.Content align="start" className="w-64">
          {saved.length === 0 && (
            <div className="px-2 py-1.5 text-[12px] text-kumo-subtle">
              No saved tests for this function yet.
            </div>
          )}
          {saved.map((test) => (
            <DropdownMenu.Item
              key={test.name}
              onClick={() => onLoad(test)}
              data-testid="saved-item"
            >
              <span className="min-w-0 flex-1 truncate">{test.name}</span>
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={<TrashIcon />}
                aria-label={`Delete ${test.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  deleteTest(project, functionId, test.name)
                }}
              />
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon={FloppyDiskIcon}
            onClick={() => setNaming(true)}
            data-testid="saved-save-as"
          >
            Save as…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={DownloadSimpleIcon}
            disabled={saved.length === 0}
            onClick={() => exportFile(functionId, saved)}
          >
            Export…
          </DropdownMenu.Item>
          <DropdownMenu.Item icon={UploadSimpleIcon} onClick={() => file.current?.click()}>
            Import…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const chosen = event.target.files?.[0]
          event.target.value = ''
          if (!chosen) return
          void chosen.text().then((text) => {
            const result = importTests(project, functionId, text)
            toast(
              'refused' in result
                ? {
                    key: 'functions.saved-tests',
                    title: 'Could not import the tests',
                    description: result.refused,
                    tone: 'warning',
                  }
                : {
                    key: 'functions.saved-tests',
                    title: `Imported ${formatNumber(result.imported)} saved ${result.imported === 1 ? 'test' : 'tests'}`,
                    tone: 'success',
                  },
            )
          })
        }}
      />
    </>
  )
}

function exportFile(functionId: string, tests: readonly SavedTest[]) {
  const blob = new Blob([exportTests(functionId, tests)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${functionId}.tests.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The paused warning a test event shows before it is sent (the only paused-state copy compute draws). */
export function PausedWarning() {
  const status = useQuery(statusQuery)
  const resume = useMutation({
    mutationFn: () => apiSend<unknown>('POST', '/suite/background', { enabled: true }),
  })
  if (status.data?.backgroundTriggers.enabled !== false) return null
  return (
    <div
      className="flex items-start gap-2 rounded-lg bg-kumo-warning-tint px-3 py-2 text-[13px]"
      data-testid="run-paused"
    >
      <span className="min-w-0 flex-1 text-kumo-default">
        Background triggers are paused, so this event is recorded as Paused and your handler does
        not run.
      </span>
      <Button
        variant="secondary"
        size="xs"
        loading={resume.isPending}
        onClick={() => resume.mutate()}
        data-testid="run-resume"
      >
        Resume
      </Button>
    </div>
  )
}

/** An invocation's own log lines, from its record and then live while it runs. */
function InvocationLogs({
  project,
  id,
  running,
}: {
  project: string
  id: string
  running: boolean
}) {
  const [store] = useState(() => createFeedStore<FunctionLogLine>({ max: 2_000, key: lineKey }))
  const view = useQuery({ ...invocationQuery(project, id), enabled: project !== '' })
  useInvocationLive(running ? id : null)
  const lines = view.data?.detail.logs
  useEffect(() => {
    if (lines) store.upsert(lines)
  }, [lines, store])
  const count = lines?.length ?? 0
  return (
    <section className="grid gap-1" aria-label="Logs" data-testid="run-logs">
      <h4 className="m-0 text-[12px] font-normal text-kumo-subtle">
        Logs · {count === 0 ? 'none yet' : formatNumber(count)}
      </h4>
      {count > 0 && (
        <div className="max-h-72 overflow-hidden rounded-md ring ring-kumo-line">
          <LogLines
            ariaLabel="This invocation's log lines"
            store={store}
            mode="invocation"
            running={running}
            className="max-h-72"
          />
        </div>
      )}
    </section>
  )
}

/** The answer's head: the invocation it made (opens it), how it ended, how long it took. */
export function RunAnswer({
  project,
  invocation,
  finished,
  onOpen,
  outcome = true,
  children,
}: {
  project: string
  /** Draw how it ended in the head (an HTTP answer's own status line says it already). */
  outcome?: boolean | undefined
  /** The invocation as it started (`started`). */
  invocation: InvocationSummary | undefined
  /** As it finished. */
  finished?: InvocationSummary | undefined
  onOpen: (id: string) => void
  /** The answer itself: a response, a callable's result, an event's outcome. */
  children?: ReactNode
}) {
  const shown = finished ?? invocation
  return (
    <section
      className="grid gap-2 border-t border-kumo-line px-5 py-3"
      aria-label="The answer"
      data-testid="run-answer"
    >
      {shown && (
        <div className="flex min-w-0 items-center gap-2">
          {outcome ? (
            <>
              <OutcomeChip
                outcome={shown.outcome}
                outcomeClass={shown.outcomeClass}
                status={shown.status ?? undefined}
                callableStatus={shown.callableStatus ?? undefined}
                startedAt={shown.startedAt}
                detail={shown.error ?? undefined}
                testId="run-outcome"
              />
              <DurationText ms={shown.durationMs} cold={shown.cold} />
            </>
          ) : (
            <span className="text-[12px] text-kumo-subtle">
              Invocation{shown.cold ? ' · started the worker' : ''}
            </span>
          )}
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto font-mono"
            onClick={() => onOpen(shown.id)}
            data-testid="run-invocation"
          >
            #{formatNumber(shown.seq)} ›
          </Button>
        </div>
      )}
      {children}
      {shown && (
        <InvocationLogs
          project={project}
          id={shown.id}
          running={finished === undefined && shown.outcome === null}
        />
      )}
    </section>
  )
}

/** A failure before any invocation: the engine's sentence and its fix. */
export function RunError({ message, fix }: { message: string; fix?: string | undefined }) {
  return (
    <div className="grid gap-1 rounded-lg bg-kumo-danger-tint px-3 py-2" data-testid="run-error">
      <Text variant="error" size="sm">
        {message}
      </Text>
      {fix && <span className="text-[12px] text-kumo-default">{fix}</span>}
    </div>
  )
}

/**
 * The next finished invocation of `functionId` that `matches` (a write's
 * trigger, a publish's delivery, a task's dispatch), followed on the live
 * tail of `functions.events` while asked for (`matches: null` = not now).
 */
export function useNextInvocation(
  functionId: string,
  matches: ((invocation: InvocationSummary) => boolean) | null,
): InvocationSummary | undefined {
  const [found, setFound] = useState<{ for: unknown; invocation: InvocationSummary } | undefined>()
  const latest = useRef(matches)
  useEffect(() => {
    latest.current = matches
  })
  useLiveTopic('functions.events', matches ? { function: functionId } : null, {
    onBatch: (batch) => {
      const test = latest.current
      if (!test) return
      for (const item of batch.items)
        if (item.outcome !== null && test(item)) {
          setFound({ for: test, invocation: item })
          return
        }
    },
  })
  return found && found.for === matches ? found.invocation : undefined
}
