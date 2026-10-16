// Call, for a callable function: the hardest call to make by hand made one
// click. The data (the console wraps it as `{"data": …}`), who it is called
// as (an Auth user's real token from the engine, an anonymous user, or any
// custom identity with its claims), App Check, and for a second-generation
// callable a streamed answer. The answer is unwrapped the way the SDK
// unwraps it: the result, or the error's status word, message and details;
// streamed chunks as they come.

import { Button, Checkbox, Input, Select, Text } from '@cloudflare/kumo'
import { StopIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import { IdentityPicker } from '@/components/console/identity-picker'
import { JsonField, parseJsonText } from '@/components/console/json-field'
import { JsonView } from '@/components/console/json-view'
import { requestAsCode } from '@/components/console/request/as-code'
import { SendButton } from '@/components/console/request/send-button'
import type { ResponseRecord } from '@/components/console/request/types'
import { formatNumber } from '@/lib/format'
import { invocationQuery } from '../api'
import { type CallableAnswer, callableBody, readCallableResponse } from '../callable'
import { type IdentityHeader, identityHeaders, useIdentityHeaders } from '../identity-headers'
import { callableInvokeCommand } from '../invoke-command'
import { createResponseBuilder, invokeFunction, stopWaiting } from '../invoke-stream'
import { type CallableDraft, useRunDraft } from '../run-drafts'
import { CopyAsMenu, FormRow, RunAnswer, RunError, RunFooter } from './run-parts'

/** A recorded call's `data` as text to edit (the body was `{"data": …}`). */
export function recordedData(body: string): string {
  try {
    const value = JSON.parse(body) as unknown
    if (value !== null && typeof value === 'object' && 'data' in value)
      return JSON.stringify((value as { data: unknown }).data, null, 2)
  } catch {
    // Not the callable protocol: offer it as it was.
  }
  return body
}

export function emptyCallableDraft(): CallableDraft {
  return {
    kind: 'callable',
    data: '{}',
    identity: { kind: 'owner' },
    appCheck: { kind: 'none' },
    stream: false,
  }
}

interface Run {
  record?: ResponseRecord | undefined
  started?: InvocationSummary | undefined
  finished?: InvocationSummary | undefined
  error?: { message: string; fix?: string | undefined } | undefined
  streaming: boolean
}

/** The headers a call sends: JSON, a streamed answer when asked, and Call as's. */
export function callableHeaders(draft: CallableDraft, identity: readonly IdentityHeader[]) {
  return [
    { name: 'content-type', value: 'application/json' },
    ...(draft.stream ? [{ name: 'accept', value: 'text/event-stream' }] : []),
    ...identity.map((header) => ({ name: header.name, value: header.value })),
  ]
}

function Answer({ answer }: { answer: CallableAnswer }) {
  if (answer.kind === 'result')
    return (
      <div className="grid gap-1" data-testid="callable-result">
        <span className="text-[12px] text-kumo-subtle">result</span>
        <div className="overflow-hidden rounded-md ring ring-kumo-line">
          <JsonView value={answer.result} height="content" raw={false} />
        </div>
      </div>
    )
  if (answer.kind === 'error')
    return (
      <div className="grid gap-1" data-testid="callable-error">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className="font-mono text-[12px] text-kumo-warning"
            data-testid="callable-error-status"
          >
            {answer.status}
          </span>
          <span className="min-w-0 text-[13px] text-kumo-default">{answer.message}</span>
        </span>
        {answer.details !== undefined && answer.details !== null && (
          <div className="overflow-hidden rounded-md ring ring-kumo-line">
            <JsonView value={answer.details} height="content" raw={false} />
          </div>
        )}
      </div>
    )
  if (answer.kind === 'stream')
    return (
      <div className="grid gap-1.5" data-testid="callable-stream">
        <span className="text-[12px] text-kumo-subtle">
          {formatNumber(answer.chunks.length)} {answer.chunks.length === 1 ? 'chunk' : 'chunks'}
          {answer.done ? '' : ' so far'}
        </span>
        <ol className="m-0 grid gap-1 p-0">
          {answer.chunks.map((chunk, index) => (
            <li
              // Chunks only append: a chunk's place is its identity.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className="flex list-none items-start gap-2 font-mono text-[12px]"
              data-testid="callable-chunk"
            >
              <span className="w-5 shrink-0 text-right text-[11px] text-kumo-subtle tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere] text-kumo-default">
                {JSON.stringify(chunk)}
              </span>
            </li>
          ))}
        </ol>
        {answer.result !== undefined && (
          <Answer answer={{ kind: 'result', result: answer.result }} />
        )}
        {answer.error && <Answer answer={{ kind: 'error', ...answer.error }} />}
      </div>
    )
  return (
    <div className="grid gap-1">
      <span className="text-[12px] text-kumo-subtle">
        The function answered {answer.status} outside the callable protocol:
      </span>
      <pre className="max-h-60 overflow-auto rounded-md bg-kumo-control p-3 font-mono text-[12px] whitespace-pre-wrap text-kumo-default ring ring-kumo-line">
        {answer.text}
      </pre>
    </div>
  )
}

export function CallableForm({
  project,
  detail,
  url,
  prefill,
  onPrefilled,
  onOpenInvocation,
}: {
  project: string
  detail: FunctionDetail
  url: string
  prefill?: string | undefined
  onPrefilled: () => void
  onOpenInvocation: (id: string) => void
}) {
  const summary = detail.summary
  const [draft, setDraft] = useRunDraft<CallableDraft>(project, summary.id, emptyCallableDraft)
  const [run, setRun] = useState<Run | null>(null)
  const parsed = parseJsonText(draft.data)
  const problem =
    draft.data.trim() !== '' && !parsed.ok ? 'The data does not parse as JSON.' : undefined
  const v2 = summary.platform === 'gcfv2'
  const update = (patch: Partial<CallableDraft>) => setDraft({ ...draft, ...patch })
  const container = useRef<HTMLDivElement>(null)

  // Edit and replay: the recorded call's data fills the draft, then the param goes.
  const recorded = useQuery({
    ...invocationQuery(project, prefill ?? ''),
    enabled: prefill !== undefined && project !== '',
  })
  useEffect(() => {
    if (!prefill || !recorded.data) return
    setDraft({ ...draft, data: recordedData(recorded.data.detail.request.body.text) })
    onPrefilled()
    // Once per prefill.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, recorded.data])
  const resolved = useIdentityHeaders(draft.identity, draft.appCheck, project).data ?? []

  useEffect(() => {
    container.current?.querySelector<HTMLElement>('.cm-content, textarea')?.focus()
  }, [])

  const send = async () => {
    if (problem) return
    const builder = createResponseBuilder(new Date().toISOString())
    setRun({ streaming: true })
    let identity: IdentityHeader[]
    try {
      identity = await identityHeaders(draft.identity, draft.appCheck, project)
    } catch (error) {
      setRun({
        streaming: false,
        error: {
          message: error instanceof Error ? error.message : 'Could not get a token for Call as.',
        },
      })
      return
    }
    try {
      const outcome = await invokeFunction(
        summary.id,
        {
          target: 'url',
          method: 'POST',
          path: '/',
          headers: callableHeaders(draft, identity),
          body: callableBody(draft.data),
          encoding: 'text',
        },
        {
          onFrame: (frame) => {
            const record = builder.apply(frame)
            setRun((current) => ({
              ...current,
              streaming: frame.frame !== 'finished' && frame.frame !== 'failed',
              record,
              ...(frame.frame === 'started' ? { started: frame.invocation } : {}),
              ...(frame.frame === 'finished' ? { finished: frame.invocation } : {}),
            }))
          },
        },
      )
      setRun((current) => ({
        ...current,
        streaming: false,
        ...(outcome.failed ? { error: { message: outcome.failed } } : {}),
      }))
    } catch (error) {
      setRun({
        streaming: false,
        error:
          error instanceof ApiError
            ? { message: error.message, fix: error.fix }
            : { message: String(error) },
      })
    }
  }

  const record = run?.record
  const bodyText = record?.bodyText ?? record?.chunks?.map((chunk) => chunk.text).join('')
  const answer =
    record && record.status !== 0 && bodyText !== undefined
      ? readCallableResponse(record.status, record.contentType, bodyText)
      : undefined
  const composed = {
    method: 'POST' as const,
    url,
    codeUrl: url,
    query: [],
    headers: callableHeaders(draft, resolved).map((header) => ({
      key: header.name,
      value: header.value,
      enabled: true,
    })),
    body: { kind: 'json' as const, text: problem ? draft.data : callableBody(draft.data) },
    // The headers above carry Call as; code adds no other.
    identity: { kind: 'anonymous' } as const,
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="callable-form" ref={container}>
      <div className="grid shrink-0 gap-3 px-5 py-3">
        <div className="grid gap-1">
          <span className="text-[12px] text-kumo-subtle">Data</span>
          <JsonField
            value={draft.data}
            onChange={(data) => update({ data })}
            minLines={6}
            maxLines={16}
            ariaLabel="Data"
            testId="callable-data"
          />
          <span className="text-[11px] text-kumo-subtle">
            Sent as {'{"data": …}'}, the way the Functions SDK sends it.
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <IdentityPicker
            project={project}
            value={draft.identity}
            onChange={(identity) => update({ identity })}
            ownerLabel="No auth"
            testId="callable-call-as"
          />
        </div>
        <FormRow label="App Check">
          <Select
            size="sm"
            aria-label="App Check"
            value={draft.appCheck.kind}
            onValueChange={(next) =>
              update({ appCheck: next === 'app' ? { kind: 'app', appId: '' } : { kind: 'none' } })
            }
            items={[
              { value: 'none', label: 'None' },
              { value: 'app', label: 'Token for app id' },
            ]}
            className="w-40 shrink-0"
          />
          {draft.appCheck.kind === 'app' && (
            <Input
              size="sm"
              className="min-w-0 flex-1 font-mono"
              value={draft.appCheck.appId}
              onChange={(event) => update({ appCheck: { kind: 'app', appId: event.target.value } })}
              placeholder="1:123:web:abc"
              aria-label="App id"
              spellCheck={false}
              data-testid="callable-app-id"
            />
          )}
        </FormRow>
        {v2 && (
          <FormRow label="Stream">
            <Checkbox
              checked={draft.stream}
              onCheckedChange={(checked) => update({ stream: Boolean(checked) })}
              label="Accept text/event-stream (sendChunk)"
            />
          </FormRow>
        )}
        {problem && (
          <Text size="xs" variant="error">
            {problem}
          </Text>
        )}
      </div>
      <RunFooter
        tools={
          <>
            <CopyAsMenu
              dialects={[
                { id: 'curl', label: 'curl', text: requestAsCode(composed, 'curl', project) },
                { id: 'fetch', label: 'fetch', text: requestAsCode(composed, 'fetch', project) },
                {
                  id: 'cli',
                  label: 'firenook functions:invoke',
                  text: callableInvokeCommand({
                    name: summary.name,
                    region: summary.region,
                    dataText: draft.data,
                  }),
                },
              ]}
            />
          </>
        }
        primary={
          <>
            {run?.streaming && (
              <Button variant="ghost" size="sm" icon={<StopIcon />} onClick={stopWaiting}>
                Stop waiting
              </Button>
            )}
            <SendButton
              label="Call"
              onSend={() => void send()}
              pending={run?.streaming ?? false}
              disabled={problem !== undefined}
              testId="callable-send"
            />
          </>
        }
      />
      {run && (
        <RunAnswer
          project={project}
          invocation={run.started}
          finished={run.finished}
          onOpen={onOpenInvocation}
        >
          {run.error && <RunError message={run.error.message} fix={run.error.fix} />}
          {answer && <Answer answer={answer} />}
        </RunAnswer>
      )}
    </div>
  )
}
