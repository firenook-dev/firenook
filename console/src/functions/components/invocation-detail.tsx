// One invocation, the run view: how it ended and why, how long each part
// took, what caused it (each a link into the section that holds it), and
// then what it got and gave — the request or the event, the response, and
// only its own log lines, live while it runs. Replay sends the same request
// again against the code loaded now; Edit and replay puts it in the Run tab.

import { Button, DropdownMenu, Tabs, Text, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  CaretDownIcon,
  PencilSimpleIcon,
  ScrollIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { FunctionLogLine } from '@/api/generated/compute/FunctionLogLine'
import type { InvocationDetail as Detail } from '@/api/generated/compute/InvocationDetail'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { EntityLink } from '@/components/console/entity-link'
import { QueryError } from '@/components/console/empty-state'
import {
  Inspector,
  InspectorFooter,
  InspectorSection,
  InspectorTitle,
} from '@/components/console/inspector'
import { JsonView } from '@/components/console/json-view'
import { type KeyValueItem, KeyValueList } from '@/components/console/key-value-list'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { RelativeTime } from '@/components/console/relative-time'
import { shellQuote } from '@/components/console/request/as-code'
import { formatClock, formatNumber, useClockFormat } from '@/lib/format'
import { createFeedStore } from '@/lib/live/feed-store'
import { invocationQuery } from '../api'
import { chipStatus } from '../kinds'
import { useInvocationLive } from '../live'
import { useFunctionsAddress } from '../use-functions'
import { type InvocationActions, causeRefs, refLabel } from './invocation-actions'
import { regionOfId, shortFunction } from './invocation-row'
import { LogLines, lineKey } from './log-lines'
import { RequestView } from './request-view'
import { CopyAsMenu } from './run-parts'
import { TimingBar } from './timing-bar'

type Tab = 'request' | 'response' | 'logs' | 'event'

/** Where a stack frame opens, per browser: an editor's URL scheme, or nowhere. */
export type EditorChoice = 'vscode' | 'cursor' | 'jetbrains' | 'none'

const EDITOR_KEY = 'firenook.console.editor'

export const EDITORS: readonly { id: EditorChoice; label: string }[] = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'jetbrains', label: 'JetBrains' },
  { id: 'none', label: 'Nowhere' },
]

function readEditor(): EditorChoice {
  try {
    const stored = localStorage.getItem(EDITOR_KEY)
    return EDITORS.some((editor) => editor.id === stored) ? (stored as EditorChoice) : 'vscode'
  } catch {
    return 'vscode'
  }
}

/** The editor URL of a frame `path:line:column`, or undefined when frames open nowhere. */
export function frameUrl(
  editor: EditorChoice,
  path: string,
  line: string,
  column: string,
): string | undefined {
  switch (editor) {
    case 'vscode':
      return `vscode://file${path}:${line}:${column}`
    case 'cursor':
      return `cursor://file${path}:${line}:${column}`
    case 'jetbrains':
      return `jetbrains://idea/navigate/reference?path=${encodeURIComponent(`${path}:${line}:${column}`)}`
    case 'none':
      return undefined
  }
}

/** A stack line's frame in the project: an absolute path outside node_modules, with its line and column. */
export function frameOf(
  line: string,
): { path: string; line: string; column: string; start: number; end: number } | undefined {
  const match = /(\/[^\s():]+):(\d+):(\d+)/.exec(line)
  if (!match?.[1] || match[1].includes('/node_modules/') || line.includes('node:internal'))
    return undefined
  return {
    path: match[1],
    line: match[2] ?? '1',
    column: match[3] ?? '1',
    start: match.index,
    end: match.index + match[0].length,
  }
}

/** A callable's error answer (`{"error": {status, message}}`), when the body is one. */
function callableError(text: string): { status: string; message: string } | undefined {
  try {
    const value = JSON.parse(text) as { error?: { status?: unknown; message?: unknown } }
    if (typeof value.error?.status === 'string')
      return {
        status: value.error.status,
        message: typeof value.error.message === 'string' ? value.error.message : '',
      }
  } catch {
    // Not JSON: said as it was.
  }
  return undefined
}

/**
 * The error's text: the handler's own `function.error` line, else the
 * summary's first line, else — for a failure the function answered itself
 * — its status and the start of its answer.
 */
export function errorText(detail: Detail): string | undefined {
  const line = detail.logs.find((entry) => entry.kind === 'function.error')
  if (line) return line.message
  if (detail.summary.error) return detail.summary.error
  const response = detail.response
  if (detail.summary.outcomeClass === 'failed' && response) {
    const text = response.body.encoding === 'text' ? response.body.text : ''
    const callable = callableError(text)
    if (callable) return `${callable.status}: ${callable.message}`
    const body = text.slice(0, 200)
    return body.trim() === ''
      ? `The function answered ${response.status}.`
      : `The function answered ${response.status}.\n${body}`
  }
  return undefined
}

/** A CloudEvent's attributes as facts (everything but its data), or undefined for another shape. */
export function eventAttributes(event: unknown): KeyValueItem[] | undefined {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return undefined
  const fields = event as Record<string, unknown>
  if (!('specversion' in fields) && !('type' in fields)) return undefined
  return Object.entries(fields)
    .filter(
      ([key, value]) => key !== 'data' && (typeof value === 'string' || typeof value === 'number'),
    )
    .map(([key, value]) => ({ label: key, value: String(value), copy: String(value) }))
}

function ErrorBlock({ text, failed }: { text: string; failed: boolean }) {
  const [editor, setEditor] = useState<EditorChoice>(readEditor)
  const lines = text.split('\n')
  const compiled = lines.some((line) => frameOf(line)?.path.includes('/lib/'))
  const framed = lines.some((line) => frameOf(line) !== undefined)
  const choose = (next: EditorChoice) => {
    setEditor(next)
    try {
      localStorage.setItem(EDITOR_KEY, next)
    } catch {
      // Kept for this page only.
    }
  }
  return (
    <section
      className={`grid gap-1 px-5 py-3 ${failed ? 'bg-kumo-danger-tint' : 'bg-kumo-warning-tint'}`}
      aria-label="Error"
      data-testid="invocation-error"
    >
      <div className="flex items-center gap-2">
        <h3 className="m-0 text-[12px] font-normal text-kumo-subtle">Error</h3>
        {framed && (
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button variant="ghost" size="xs" className="ml-auto">
                  <span className="flex items-center gap-1 text-[11px] text-kumo-subtle">
                    Frames open in {EDITORS.find((entry) => entry.id === editor)?.label}
                    <CaretDownIcon size={10} />
                  </span>
                </Button>
              }
            />
            <DropdownMenu.Content align="end">
              {EDITORS.map((entry) => (
                <DropdownMenu.Item key={entry.id} onClick={() => choose(entry.id)}>
                  {entry.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu>
        )}
      </div>
      <pre className="m-0 max-h-64 overflow-auto font-mono text-[11px] leading-5 whitespace-pre-wrap text-kumo-subtle [overflow-wrap:anywhere]">
        {lines.map((line, index) => {
          const frame = frameOf(line)
          const url = frame ? frameUrl(editor, frame.path, frame.line, frame.column) : undefined
          return (
            <span
              // The lines of one stack never reorder.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className={index === 0 ? 'block text-[12px] font-medium text-kumo-default' : 'block'}
            >
              {frame && url ? (
                <>
                  {line.slice(0, frame.start)}
                  <a className="text-kumo-link hover:underline" href={url}>
                    {line.slice(frame.start, frame.end)}
                  </a>
                  {line.slice(frame.end)}
                </>
              ) : (
                line
              )}
            </span>
          )
        })}
      </pre>
      {compiled && (
        <Text size="xs" variant="secondary">
          Start the emulator with{' '}
          <span className="font-mono">NODE_OPTIONS=--enable-source-maps</span> to see your
          TypeScript lines.
        </Text>
      )}
    </section>
  )
}

function InvocationLogsTab({ detail, running }: { detail: Detail; running: boolean }) {
  const [store] = useState(() => createFeedStore<FunctionLogLine>({ max: 2_000, key: lineKey }))
  const lines = detail.logs
  useEffect(() => {
    store.upsert(lines)
  }, [lines, store])
  if (lines.length === 0)
    return (
      <p className="px-5 py-3 text-[13px] text-kumo-subtle" data-testid="invocation-logs-empty">
        {running ? 'Nothing printed yet.' : 'It printed nothing.'}
      </p>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="invocation-logs">
      {detail.logsDropped > 0 && (
        <p className="px-5 pt-2 text-[12px] text-kumo-subtle">
          {formatNumber(detail.logsDropped)} later lines were not kept (1,000 line limit); Logs has
          them.
        </p>
      )}
      <LogLines
        ariaLabel="This invocation's log lines"
        store={store}
        mode="invocation"
        running={running}
        className="min-h-0 flex-1"
      />
    </div>
  )
}

/** The curl command for a URL invocation, against the function as apps reach it (sensitive headers left out). */
export function invocationCurl(
  detail: Detail,
  functionUrl: string | undefined,
): string | undefined {
  if (detail.request.target !== 'url' || !functionUrl) return undefined
  const request = detail.request
  const lines = [
    `curl -X ${request.method} ${shellQuote(`${functionUrl}${request.path === '/' ? '' : request.path}`)}`,
  ]
  for (const header of request.headers)
    if (
      header.value !== null &&
      !header.sensitive &&
      !/^(host|content-length|connection|x-firenook-)/i.test(header.name)
    )
      lines.push(`  -H ${shellQuote(`${header.name}: ${header.value}`)}`)
  if (request.body.encoding === 'text' && request.body.text !== '')
    lines.push(`  --data-raw ${shellQuote(request.body.text)}`)
  return lines.join(' \\\n')
}

export function InvocationDetail({
  project,
  id,
  widthKey,
  actions,
  onClose,
  onBack,
  onPrev,
  onNext,
}: {
  project: string
  id: string
  widthKey: 'functions.function' | 'functions.invocation'
  actions: InvocationActions
  onClose: () => void
  /** Back to the function's tabs (the function page). */
  onBack?: (() => void) | undefined
  /** The newer and older row of the list it was opened from. */
  onPrev?: (() => void) | undefined
  onNext?: (() => void) | undefined
}) {
  const view = useQuery({ ...invocationQuery(project, id), enabled: project !== '' })
  const detail = view.data?.detail
  const running = detail?.summary.outcome === null
  useInvocationLive(running ? id : null)
  const [tab, setTab] = useState<Tab>('logs')
  const { format } = useClockFormat()
  const address = useFunctionsAddress()
  const summary: InvocationSummary | undefined = detail?.summary
  const functionUrl =
    summary && address
      ? `${address}/${project}/${summary.functionId.replace(/^([a-z]+-[a-z]+\d+)-/, '$1/')}`
      : undefined
  const background = detail?.event !== null && detail?.event !== undefined
  const tabs: { value: Tab; label: string }[] = detail
    ? [
        { value: 'request', label: 'Request' },
        ...(background ? [{ value: 'event' as const, label: 'Event' }] : []),
        { value: 'response', label: 'Response' },
        { value: 'logs', label: `Logs · ${formatNumber(detail.logs.length)}` },
      ]
    : []
  const error = detail ? errorText(detail) : undefined
  const failed = summary?.outcomeClass === 'failed'

  return (
    <Inspector
      widthKey={widthKey}
      title={
        <span className="flex min-w-0 items-center gap-1">
          {onBack && (
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowLeftIcon />}
              onClick={onBack}
              data-testid="invocation-back"
            >
              Back
            </Button>
          )}
          <InspectorTitle value={id}>#{summary ? formatNumber(summary.seq) : id}</InspectorTitle>
        </span>
      }
      meta={summary ? <RelativeTime iso={summary.startedAt} /> : undefined}
      onClose={onClose}
      closeLabel="Close the invocation"
      noun="invocation"
      onPrev={onPrev}
      onNext={onNext}
      testId="invocation-detail"
      footer={
        summary &&
        detail && (
          <InspectorFooter
            tools={
              <>
                <CopyAsMenu
                  testId="invocation-copy-as"
                  dialects={[
                    {
                      id: 'curl',
                      label: 'curl',
                      text: invocationCurl(detail, functionUrl),
                      refused:
                        detail.request.target === 'url'
                          ? undefined
                          : 'A delivery to the trigger route is not something an app calls; replay it instead.',
                    },
                    {
                      id: 'cli',
                      label: 'firenook functions:invoke',
                      text:
                        detail.event !== null && detail.event !== undefined
                          ? `firenook functions:invoke ${shortFunction(summary.functionId)} --event-data ${shellQuote(JSON.stringify(detail.event))}`
                          : undefined,
                      refused:
                        detail.event === null
                          ? 'For a URL invocation, copy it as curl.'
                          : undefined,
                    },
                    { id: 'json', label: 'JSON', text: JSON.stringify(summary, null, 2) },
                  ]}
                />
                {actions.openLogs && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<ScrollIcon />}
                    onClick={() => actions.openLogs?.(summary)}
                    data-testid="invocation-logs-link"
                  >
                    Logs
                  </Button>
                )}
              </>
            }
            primary={
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<PencilSimpleIcon />}
                  onClick={() => actions.editAndReplay(summary)}
                  data-testid="invocation-edit-replay"
                >
                  Edit and replay
                </Button>
                {detail.replayable ? (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<ArrowCounterClockwiseIcon />}
                    loading={actions.replaying}
                    onClick={() => actions.replay(summary)}
                    data-testid="invocation-replay"
                  >
                    Replay
                  </Button>
                ) : (
                  <Tooltip
                    content={detail.notReplayable ?? 'It cannot be replayed.'}
                    render={
                      <span className="inline-flex">
                        <Button
                          variant="primary"
                          size="sm"
                          icon={<ArrowCounterClockwiseIcon />}
                          disabled
                          data-testid="invocation-replay"
                        >
                          Replay
                        </Button>
                      </span>
                    }
                  />
                )}
              </>
            }
          />
        )
      }
    >
      {view.error ? (
        <QueryError error={view.error} onRetry={() => void view.refetch()} section="functions" />
      ) : !detail || !summary ? (
        <div aria-busy className="min-h-0 flex-1" />
      ) : (
        <>
          <section
            className="grid shrink-0 gap-2 px-5 py-3"
            aria-label="How it ended"
            data-testid="invocation-head"
          >
            <div className="flex min-w-0 items-center gap-2">
              {/* The chip's own wrapper may shrink; beside a long summary it must not, or the summary draws over it. */}
              <span className="flex shrink-0 items-center">
                <OutcomeChip
                  outcome={summary.outcome}
                  outcomeClass={summary.outcomeClass}
                  status={chipStatus(summary)}
                  callableStatus={summary.callableStatus ?? undefined}
                  startedAt={summary.startedAt}
                  testId="invocation-detail-outcome"
                />
              </span>
              <span
                className="min-w-0 truncate font-mono text-[13px] text-kumo-default"
                data-testid="invocation-detail-summary"
              >
                {summary.summary}
              </span>
            </div>
            <p className="m-0 text-[12px] text-kumo-subtle">
              <span className="font-mono">{shortFunction(summary.functionId)}</span> ·{' '}
              {regionOfId(summary.functionId)} · {summary.origin} ·{' '}
              <span className="font-mono tabular-nums">
                {formatClock(summary.startedAt, format)}
              </span>
              {summary.attempt > 1 && <> · attempt {summary.attempt}</>}
            </p>
            {summary.replayOf && (
              <p
                className="m-0 flex items-center gap-1.5 text-[12px] text-kumo-subtle"
                data-testid="invocation-replay-of"
              >
                Replay of{' '}
                <EntityLink
                  entity={{
                    kind: 'functions.invocation',
                    key: summary.replayOf,
                    label: `#${summary.replayOf.split('-').pop() ?? summary.replayOf}`,
                  }}
                />
              </p>
            )}
            <TimingBar timings={detail.timings} running={running} />
            {causeRefs(view.data?.refs ?? []).filter((ref) => ref.kind !== 'functions.invocation')
              .length > 0 && (
              <p
                className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-kumo-subtle"
                data-testid="invocation-cause"
              >
                Caused by
                {causeRefs(view.data?.refs ?? [])
                  .filter((ref) => ref.kind !== 'functions.invocation')
                  .map((ref) => (
                    <EntityLink
                      key={`${ref.kind}:${ref.key}`}
                      entity={{ ...ref, label: refLabel(ref) }}
                      testId={`cause-${ref.kind}`}
                    />
                  ))}
              </p>
            )}
          </section>
          {error && (failed || summary.outcome === 'blocked') && (
            <ErrorBlock text={error} failed={failed} />
          )}
          <div className="flex h-11 shrink-0 items-center border-y border-kumo-line px-3">
            <Tabs
              variant="underline"
              size="sm"
              value={tab}
              onValueChange={(next) => setTab(next as Tab)}
              tabs={tabs}
            />
          </div>
          {tab === 'logs' ? (
            <InvocationLogsTab detail={detail} running={running} />
          ) : tab === 'event' ? (
            <EventTab event={detail.event} />
          ) : (
            <RequestView detail={detail} part={tab} />
          )}
        </>
      )}
    </Inspector>
  )
}

function EventTab({ event }: { event: unknown }) {
  const attributes = eventAttributes(event)
  const data = attributes ? (event as Record<string, unknown>).data : event
  return (
    <div className="flex flex-col" data-testid="invocation-event">
      {attributes && (
        <InspectorSection title="Attributes" count={attributes.length}>
          <KeyValueList items={attributes} />
        </InspectorSection>
      )}
      <InspectorSection title={attributes ? 'Data' : 'Event'}>
        <div className="overflow-hidden rounded-md ring ring-kumo-line">
          <JsonView value={data} height="content" raw={false} />
        </div>
      </InspectorSection>
    </div>
  )
}
