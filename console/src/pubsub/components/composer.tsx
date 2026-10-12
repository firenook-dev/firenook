// The composer (S3, PS-10…PS-19): a message written and published from the
// inspector's place beside the list. Data as JSON, text or base64 (on a
// BINARY schema topic, JSON sent as Avro binary); attributes; an ordering
// key; copies at once or on an interval. On a schema-bound topic the data is
// checked against the bound revision as it is typed, the failing field
// marked where it is written; templates (`{{i}}`, `{{uuid}}`, `{{now}}`,
// `{{ts}}`) are expanded by the engine for the preview of message 1, so the
// preview and the publish cannot disagree; what production would refuse and
// the emulator takes is said in amber. One message is one request; copies
// or an interval are a job the engine runs, which keeps going with this
// composer closed, or this tab.

import { Button, DropdownMenu, Input, Select, Tabs, Tooltip, cn } from '@cloudflare/kumo'
import {
  ClockCounterClockwiseIcon,
  PaperPlaneTiltIcon,
  SparkleIcon,
  StopIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import type { PubsubOutgoingMessage } from '@/api/generated/messaging/PubsubOutgoingMessage'
import type { PubsubTopicDetail } from '@/api/generated/messaging/PubsubTopicDetail'
import type { PubsubTopicSummary } from '@/api/generated/messaging/PubsubTopicSummary'
import { CodeEditor } from '@/components/code-editor'
import type { CodeMark } from '@/components/code-editor/props'
import { EntityLink } from '@/components/console/entity-link'
import { Inspector, InspectorFooter } from '@/components/console/inspector'
import { formatJsonText, parseJsonText } from '@/components/console/json-field'
import { type KeyValueRow, KeyValueEditor, rowId } from '@/components/console/key-value-editor'
import { RelativeTime } from '@/components/console/relative-time'
import { PanelTitle } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { cancelJob, useJob } from '@/lib/jobs'
import { useTriggersFor } from '@/lib/triggers'
import { publish, startPublishJob } from '../api'
import {
  type ComposerDraft,
  INTERVALS,
  type IntervalMs,
  draftKey,
  emptyDraft,
  engineWritten,
  fromRecent,
  readRecent,
  rememberDraft,
  useComposer,
} from '../composer-store'
import { spanOfPath } from '../json-path'
import { shortName } from '../names'
import {
  type DataKind,
  type DraftMessage,
  dataProblem,
  editableData,
  limitNotes,
  messageBytes,
  requestProblem,
  toWireData,
} from '../payload'
import {
  messageCheckQuery,
  messageQuery,
  publishPreviewQuery,
  schemaExampleQuery,
} from '../queries'
import { useDebounced } from './attributes-filter-field'
import { type FileMessages, PublishFileButton, fileSummary } from './publish-file'
import {
  PublishResult,
  RESULT_MS,
  jobEndText,
  jobProgressText,
  publishedText,
  skippedText,
} from './publish-result'

/** The most copies one publish makes. */
export const MAX_REPEAT = 1000

const TEMPLATE = /\{\{\s*(i|uuid|now|ts)\s*\}\}/

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.fix ? `${error.message} ${error.fix}` : error.message
  return error instanceof Error ? error.message : String(error)
}

/** The prefill parameter: a message id of this topic, or `<topic full name>|<id>` of another. */
export function prefillSource(prefill: string, topic: string): { topic: string; id: string } {
  const bar = prefill.lastIndexOf('|')
  return bar === -1
    ? { topic, id: prefill }
    : { topic: prefill.slice(0, bar), id: prefill.slice(bar + 1) }
}

/** The draft as the message the engine is sent. */
export function outgoing(draft: ComposerDraft): PubsubOutgoingMessage {
  const attributes = Object.fromEntries(
    draft.attributes
      .filter((row) => row.enabled && row.key !== '')
      .map((row) => [row.key, row.value]),
  )
  return {
    data: toWireData(draft.kind, draft.data),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(draft.orderingKey ? { orderingKey: draft.orderingKey } : {}),
  }
}

/** Whether a draft uses templates the engine expands. */
export function usesTemplates(draft: ComposerDraft): boolean {
  return TEMPLATE.test(draft.data) || draft.attributes.some((row) => TEMPLATE.test(row.value))
}

/** The repeat box's text as a count, or undefined while it is not 1 to 1,000. */
export function repeatCount(text: string): number | undefined {
  const value = Number(text)
  return Number.isInteger(value) && value >= 1 && value <= MAX_REPEAT ? value : undefined
}

function asDraftMessage(draft: ComposerDraft): DraftMessage {
  return {
    kind: draft.kind,
    data: draft.data,
    attributes: draft.attributes.filter((row) => row.enabled && row.key !== ''),
    orderingKey: draft.orderingKey,
  }
}

/** The data editor for JSON: the lazy code editor with the schema's marks, Format, and the parse line. */
function JsonDataEditor({
  value,
  onChange,
  marks,
}: {
  value: string
  onChange: (text: string) => void
  marks: readonly CodeMark[]
}) {
  const parsed = parseJsonText(value)
  const formatted = formatJsonText(value)
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        className={cn(
          'flex min-h-[calc(8*1.25rem+16px)] flex-col overflow-hidden rounded-md ring focus-within:ring-kumo-focus',
          parsed.ok ? 'ring-kumo-line' : 'ring-kumo-danger',
        )}
        // At most half the panel: the attributes and the footer stay in reach.
        style={{ maxHeight: '50vh' }}
      >
        <CodeEditor
          value={value}
          onChange={onChange}
          marks={marks}
          ariaLabel="Message data"
          testId="composer-data"
        />
      </div>
      <div className="flex min-h-6 items-start gap-2">
        {!parsed.ok && (
          <p
            className="m-0 min-w-0 flex-1 text-[12px] leading-5 text-kumo-danger"
            data-testid="composer-json-error"
          >
            Line {parsed.line}, column {parsed.column}: {parsed.message}
          </p>
        )}
        <span className="ml-auto shrink-0">
          <Button
            variant="ghost"
            size="sm"
            disabled={formatted === undefined || formatted === value}
            onClick={() => formatted !== undefined && onChange(formatted)}
            data-testid="composer-format"
          >
            Format JSON
          </Button>
        </span>
      </div>
    </div>
  )
}

/** One line of the problem strip: 13 px, in the tone of what it says. */
function Problem({
  tone,
  children,
  testId,
}: {
  tone: 'danger' | 'warning'
  children: ReactNode
  testId?: string
}) {
  return (
    <p
      className={cn(
        'm-0 text-[13px]',
        tone === 'danger' ? 'text-kumo-danger' : 'text-kumo-warning',
      )}
      data-testid={testId}
    >
      {children}
    </p>
  )
}

export function Composer({
  project,
  topic,
  detail,
  summary,
  prefill,
  onClose,
  onOpenMessage,
}: {
  project: string
  /** The topic's full name. */
  topic: string
  detail: PubsubTopicDetail | undefined
  summary: PubsubTopicSummary | undefined
  /** A message whose data, attributes and key fill the draft (`prefill`). */
  prefill: string | undefined
  onClose: () => void
  /** Opens a message the composer published. */
  onOpenMessage: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const topicId = shortName(topic)
  const schema = detail?.schema && !detail.schema.deleted ? detail.schema : undefined
  const binary = schema?.encoding === 'BINARY'
  const key = draftKey(project, topic)
  const stored = useComposer((state) => state.drafts[key])
  const store = useComposer((state) => state.set)
  const draft = stored ?? emptyDraft(binary ? 'avro-json' : 'json')
  const setDraft = (patch: Partial<ComposerDraft>) => store(key, { ...draft, ...patch })

  // A prefill fills the draft once, from the message it names.
  const source = prefill ? prefillSource(prefill, topic) : undefined
  const prefilled = useQuery({
    ...messageQuery(project, source?.topic ?? '', source?.id ?? ''),
    enabled: source !== undefined && draft.prefilledFrom !== prefill,
  })
  useEffect(() => {
    const message = prefilled.data
    if (!message || !prefill || draft.prefilledFrom === prefill) return
    const data = editableData(message.dataText, message.dataBase64, message.dataJson)
    store(key, {
      ...emptyDraft(),
      kind: binary && data.kind === 'json' ? 'avro-json' : data.kind,
      data: data.data,
      attributes: Object.entries(message.attributes)
        .filter(([name]) => !engineWritten(name))
        .map(([name, value]) => ({ id: rowId(), key: name, value, enabled: true })),
      orderingKey: message.orderingKey ?? '',
      prefilledFrom: prefill,
    })
  }, [prefilled.data, prefill, draft.prefilledFrom, store, key, binary])

  // Checks, as typed.
  const settled = useDebounced(draft, 300)
  const templated = usesTemplates(settled)
  const problem = dataProblem(draft.kind, draft.data)
  const checkable =
    schema !== undefined && !templated && dataProblem(settled.kind, settled.data) === undefined
  const check = useQuery({
    ...messageCheckQuery(project, {
      schema: `${schema?.schema ?? ''}@${schema?.boundRevisionId ?? ''}`,
      encoding: settled.kind === 'base64' ? 'BINARY' : 'JSON',
      data: toWireData(settled.kind === 'avro-json' ? 'json' : settled.kind, settled.data),
    }),
    enabled: checkable,
  })
  const schemaProblem = checkable && check.data && !check.data.ok ? check.data : undefined
  const marks: CodeMark[] = []
  if (schemaProblem?.problem && (draft.kind === 'json' || draft.kind === 'avro-json')) {
    const span = spanOfPath(draft.data, schemaProblem.problem.path)
    if (span)
      marks.push({
        from: span.from,
        to: Math.max(span.to, span.from + 1),
        severity: 'error',
        message: `expected ${schemaProblem.problem.expected}, found ${schemaProblem.problem.found}`,
      })
  }
  const preview = useQuery({
    ...publishPreviewQuery(project, { topic, messages: [outgoing(settled)], template: true }),
    enabled: templated && dataProblem(settled.kind, settled.data) === undefined,
  })
  const repeat = repeatCount(draft.repeat)
  const message = asDraftMessage(draft)
  const sizeProblem = requestProblem(messageBytes(message), repeat ?? 1)
  const limits = limitNotes(message)
  const previewProblem = templated ? preview.data?.problem : undefined

  // Example data from the engine, checked against the bound revision before it is answered.
  const example = useMutation({
    mutationFn: () => queryClient.fetchQuery(schemaExampleQuery(project, { topic })),
    onSuccess: (answer) => {
      if (answer.json)
        setDraft({
          kind: binary ? 'avro-json' : 'json',
          data: formatJsonText(answer.json) ?? answer.json,
        })
    },
  })

  // Publishing.
  const [result, setResult] = useState<
    { text: string; detail?: string | undefined; id?: string | undefined } | undefined
  >()
  useEffect(() => {
    if (!result) return undefined
    const timer = setTimeout(() => setResult(undefined), RESULT_MS)
    return () => clearTimeout(timer)
  }, [result])
  const [jobId, setJobId] = useState<string | undefined>()
  const job = useJob(jobId)
  const running = job?.state === 'running'
  const [endedJob, setEndedJob] = useState<string | undefined>()
  if (job && job.state !== 'running' && endedJob !== job.id) {
    setEndedJob(job.id)
    setResult({ text: jobEndText(job, topicId) })
  }
  const single = (repeat ?? 1) === 1 && draft.intervalMs === 0
  const send = useMutation({
    mutationFn: async () => {
      const body = { topic, messages: [outgoing(draft)], template: usesTemplates(draft) }
      if (single) return { kind: 'single' as const, answer: await publish(body) }
      return {
        kind: 'job' as const,
        answer: await startPublishJob({
          ...body,
          repeat: repeat ?? 1,
          intervalMs: draft.intervalMs,
        }),
      }
    },
    onSuccess: (sent) => {
      rememberDraft(project, topic, draft)
      setRecent(readRecent(project, topic))
      if (sent.kind === 'single') {
        const id = sent.answer.messageIds[0]
        setResult({ text: publishedText(sent.answer), detail: skippedText(sent.answer), id })
      } else {
        queryClient.setQueryData(['jobs', sent.answer.id], sent.answer)
        setJobId(sent.answer.id)
      }
    },
  })

  // From a file.
  const [file, setFile] = useState<{ name: string; result: FileMessages } | undefined>()
  const sendFile = useMutation({
    mutationFn: (messages: PubsubOutgoingMessage[]) => startPublishJob({ topic, messages }),
    onSuccess: (answer) => {
      setFile(undefined)
      queryClient.setQueryData(['jobs', answer.id], answer)
      setJobId(answer.id)
    },
  })

  const [recent, setRecent] = useState(() => readRecent(project, topic))
  const triggers = useTriggersFor('pubsub', topic)
  const ordering = summary?.subscriptions.some((subscription) => subscription.ordering) ?? false

  const blocked = problem !== undefined || sizeProblem !== undefined || repeat === undefined
  const clean = !blocked && schemaProblem === undefined && previewProblem == null
  const count = repeat ?? 1
  const interval = INTERVALS.find((entry) => entry.ms === draft.intervalMs)?.label ?? 'at once'

  const publishNow = () => {
    if (blocked || running || send.isPending) return
    send.mutate()
  }
  const panel = useRef<HTMLDivElement>(null)

  const kinds: { value: DataKind; label: string }[] = binary
    ? [
        { value: 'avro-json', label: 'JSON (sent as Avro binary)' },
        { value: 'base64', label: 'Base64' },
      ]
    : [
        { value: 'json', label: 'JSON' },
        { value: 'text', label: 'Text' },
        { value: 'base64', label: 'Base64' },
      ]

  return (
    <div
      ref={panel}
      className="contents"
      onKeyDownCapture={(event) => {
        // ⌘↵ publishes from anywhere in the composer, the code editor
        // included, where it would otherwise insert a blank line.
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          event.stopPropagation()
          publishNow()
        }
      }}
    >
      <Inspector
        widthKey="pubsub.message"
        title={
          <PanelTitle>
            Publish to <span className="font-mono text-[0.9em]">{topicId}</span>
          </PanelTitle>
        }
        meta={
          schema ? (
            <Tooltip
              content={`Checked against ${shortName(schema.schema)}, revision ${schema.boundRevisionId}`}
              render={
                <span
                  className="rounded bg-kumo-tint px-1 font-mono text-[11px] text-kumo-subtle"
                  data-testid="composer-schema"
                >
                  Avro · {schema.encoding} · rev {schema.boundRevisionId.slice(0, 8)}
                </span>
              }
            />
          ) : undefined
        }
        onClose={onClose}
        closeLabel="Close the composer"
        footer={
          <InspectorFooter
            tools={
              <>
                <DropdownMenu>
                  <DropdownMenu.Trigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<ClockCounterClockwiseIcon />}
                        disabled={recent.length === 0}
                        data-testid="composer-recent"
                      >
                        Recent
                      </Button>
                    }
                  />
                  <DropdownMenu.Content align="start" className="w-80">
                    {recent.map((entry) => (
                      <DropdownMenu.Item
                        key={entry.at}
                        className="items-start"
                        onClick={() => store(key, fromRecent(entry))}
                      >
                        <span className="grid min-w-0 gap-0.5">
                          <span className="truncate font-mono text-[12px]">
                            {entry.data.replace(/\s+/g, ' ').slice(0, 80) || '⟨empty⟩'}
                          </span>
                          <span className="text-[12px] text-kumo-subtle">
                            <RelativeTime iso={entry.at} />
                            {entry.attributes.length > 0
                              ? ` · ${entry.attributes.length} attributes`
                              : ''}
                          </span>
                        </span>
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu>
                <PublishFileButton onRead={setFile} />
              </>
            }
            primary={
              running && job ? (
                <>
                  <span
                    className="text-[12px] text-kumo-subtle tabular-nums"
                    data-testid="composer-job-progress"
                  >
                    {jobProgressText(job, interval)}
                  </span>
                  <Button
                    variant="secondary"
                    icon={<StopIcon />}
                    onClick={() => void cancelJob(job.id)}
                    data-testid="composer-stop"
                  >
                    Stop
                  </Button>
                </>
              ) : (
                <Tooltip
                  content={
                    <span className="flex items-center gap-1.5">
                      Publish{' '}
                      <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px] text-kumo-subtle">
                        ⌘↵
                      </kbd>
                    </span>
                  }
                  render={
                    <Button
                      variant={clean ? 'primary' : 'secondary'}
                      icon={<PaperPlaneTiltIcon />}
                      disabled={blocked}
                      loading={send.isPending}
                      onClick={publishNow}
                      data-testid="composer-publish"
                    >
                      {count > 1 ? `Publish ${formatNumber(count)}` : 'Publish'}
                    </Button>
                  }
                />
              )
            }
            testId="composer-footer"
          />
        }
        testId="pubsub-composer"
      >
        <div className="grid content-start gap-4 px-5 py-4">
          <section className="grid gap-2" aria-label="Data">
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-kumo-default">Data</span>
              <Tabs
                variant="segmented"
                size="sm"
                value={draft.kind}
                onValueChange={(next) => setDraft({ kind: next as DataKind })}
                tabs={kinds}
              />
              {schema && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<SparkleIcon />}
                  loading={example.isPending}
                  onClick={() => example.mutate()}
                  className="ml-auto"
                  data-testid="composer-fill-example"
                >
                  Fill example
                </Button>
              )}
            </div>
            {draft.kind === 'json' || draft.kind === 'avro-json' ? (
              <JsonDataEditor
                value={draft.data}
                onChange={(data) => setDraft({ data })}
                marks={marks}
              />
            ) : (
              <textarea
                value={draft.data}
                onChange={(event) => setDraft({ data: event.target.value })}
                rows={8}
                spellCheck={false}
                placeholder={
                  draft.kind === 'base64' ? 'eyJvcmRlcklkIjoib18xIn0=' : 'Any text, sent as UTF-8'
                }
                aria-label="Message data"
                className={cn(
                  'max-h-[50vh] min-h-[calc(8*1.25rem+16px)] w-full resize-y rounded-md bg-kumo-control p-2 font-mono text-[12px] leading-5 text-kumo-default ring outline-none placeholder:text-kumo-inactive focus:ring-kumo-focus',
                  problem ? 'ring-kumo-danger' : 'ring-kumo-line',
                )}
                data-testid="composer-data-text"
              />
            )}
            {/* The problem strip: what is wrong now, or what the last publish did. */}
            <div className="grid gap-1" data-testid="composer-problems">
              {result ? (
                <PublishResult
                  text={result.text}
                  detail={result.detail}
                  {...(result.id ? { onOpen: () => onOpenMessage(result.id ?? '') } : {})}
                />
              ) : (
                <>
                  {problem && (draft.kind === 'base64' || draft.data.trim() === '') && (
                    <Problem tone="danger">{problem}</Problem>
                  )}
                  {schemaProblem?.problem && (
                    <Problem tone="danger" testId="composer-schema-problem">
                      {schemaProblem.problem.path}: expected {schemaProblem.problem.expected}, found{' '}
                      {schemaProblem.problem.found}
                    </Problem>
                  )}
                  {schemaProblem && !schemaProblem.problem && schemaProblem.engineMessage && (
                    <Problem tone="danger">{schemaProblem.engineMessage}</Problem>
                  )}
                  {sizeProblem && <Problem tone="danger">{sizeProblem}</Problem>}
                  {send.isError && (
                    <Problem tone="danger" testId="composer-error">
                      {errorText(send.error)}
                    </Problem>
                  )}
                  {limits.map((note) => (
                    <Problem
                      key={`${note.on}-${note.index ?? ''}`}
                      tone="warning"
                      testId="composer-limit"
                    >
                      {note.on === 'key' || note.on === 'value'
                        ? `Attribute ${draft.attributes.filter((row) => row.enabled && row.key !== '')[note.index ?? 0]?.key ?? ''}: ${note.text}`
                        : note.text}
                    </Problem>
                  ))}
                </>
              )}
            </div>
          </section>

          <section className="grid gap-1" aria-label="Attributes">
            <KeyValueEditor
              label="Attributes"
              rows={draft.attributes}
              onChange={(attributes: KeyValueRow[]) => setDraft({ attributes })}
              suggestKeys={detail?.attributeKeys}
              allowDisable
              testId="composer-attributes"
            />
          </section>

          <section className="grid gap-1" aria-label="Ordering key">
            <label className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-[13px] text-kumo-default">Ordering key</span>
              <Input
                size="sm"
                value={draft.orderingKey}
                onChange={(event) => setDraft({ orderingKey: event.target.value })}
                list="composer-ordering-keys"
                placeholder="none"
                spellCheck={false}
                autoComplete="off"
                className="w-full font-mono"
                data-testid="composer-ordering-key"
              />
            </label>
            <datalist id="composer-ordering-keys">
              {(detail?.orderingKeys ?? []).map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            {draft.orderingKey && !ordering && (
              <p className="m-0 pl-27 text-[12px] text-kumo-subtle">
                No subscription on {topicId} orders by key, so it only travels with the message.
              </p>
            )}
          </section>

          <section className="grid gap-1" aria-label="Repeat">
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-[13px] text-kumo-default">Repeat</span>
              <Input
                size="sm"
                type="number"
                min={1}
                max={MAX_REPEAT}
                value={draft.repeat}
                onChange={(event) => setDraft({ repeat: event.target.value })}
                aria-label="Copies to publish"
                className="w-20 font-mono"
                data-testid="composer-repeat"
              />
              <Select
                size="xs"
                value={draft.intervalMs}
                onValueChange={(next) => setDraft({ intervalMs: Number(next) as IntervalMs })}
                aria-label="How often"
                renderValue={() => interval}
                className="h-6.5 w-36"
                data-testid="composer-interval"
              >
                {INTERVALS.map((entry) => (
                  <Select.Option key={entry.ms} value={entry.ms}>
                    {entry.label}
                  </Select.Option>
                ))}
              </Select>
            </div>
            {repeat === undefined && (
              <p className="m-0 pl-27 text-[12px] text-kumo-danger">Repeat 1 to 1,000 copies.</p>
            )}
            {templated && (
              <p
                className="m-0 truncate pl-27 font-mono text-[12px] text-kumo-subtle"
                data-testid="composer-preview"
              >
                {preview.data?.problem ? (
                  <span className="font-sans text-kumo-danger">{preview.data.problem}</span>
                ) : preview.data ? (
                  `Message 1: ${preview.data.dataText ?? preview.data.dataBase64 ?? ''}`
                ) : (
                  'Message 1: …'
                )}
              </p>
            )}
          </section>

          {file && (
            <section
              className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2 ring ring-kumo-line"
              aria-label="A file to publish"
              data-testid="composer-file"
            >
              {file.result.ok ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-default">
                    {fileSummary(file.result.messages.length, file.name)}
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={sendFile.isPending}
                    onClick={() => file.result.ok && sendFile.mutate(file.result.messages)}
                    data-testid="composer-file-publish"
                  >
                    Publish {formatNumber(file.result.messages.length)}
                  </Button>
                </>
              ) : (
                <span className="min-w-0 flex-1 text-[13px] text-kumo-danger">
                  {file.result.message}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                icon={<XIcon />}
                aria-label="Put the file away"
                onClick={() => setFile(undefined)}
              />
              {sendFile.isError && (
                <span className="w-full text-[13px] text-kumo-danger">
                  {errorText(sendFile.error)}
                </span>
              )}
            </section>
          )}

          {typeof triggers === 'object' && (
            <p
              className="m-0 flex flex-wrap items-center gap-1.5 text-[12px] text-kumo-subtle"
              data-testid="composer-triggers"
            >
              {triggers.functions.length === 0 ? (
                `No function listens on ${topicId}.`
              ) : (
                <>
                  Runs{' '}
                  {triggers.functions.map((fn) => (
                    <EntityLink
                      key={fn.functionId}
                      entity={{
                        kind: 'functions.function',
                        key: fn.functionId,
                        label: shortName(fn.functionId).replace(/^[a-z]+-[a-z]+\d+-/, ''),
                      }}
                    />
                  ))}
                </>
              )}
            </p>
          )}
        </div>
      </Inspector>
    </div>
  )
}
