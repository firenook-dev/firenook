// One call to the Auth emulator in full: what went wrong in the words the
// SDK will use and what to change; what it caused — the blocking functions it
// ran with their own messages, the triggers it queued, the codes it sent or
// used, the accounts and settings it changed; the request and the response
// as the engine kept them (passwords masked); the headers. Copy as curl
// sends the same request to the Auth emulator from a terminal; Replay sends
// it again through the console and opens the new entry, asking first when it
// is not idempotent.

import { Button, Text } from '@cloudflare/kumo'
import {
  ArrowClockwiseIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { ApiError } from '@/api/client'
import type { AuthActivityDetail } from '@/api/generated/auth/AuthActivityDetail'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import type { AuthStep } from '@/api/generated/auth/AuthStep'
import { statusQuery } from '@/api/queries'
import { ConfirmPopover } from '@/components/console/confirm-popover'
import { EntityLink } from '@/components/console/entity-link'
import {
  Inspector,
  InspectorFooter,
  InspectorSection,
  useInspectorRoom,
} from '@/components/console/inspector'
import { JsonTree } from '@/components/console/json-tree'
import { KeyValueList, type KeyValueItem } from '@/components/console/key-value-list'
import { defaultConnectHost, hostLiteral } from '@/lib/connect'
import { useNow } from '@/lib/clock'
import { formatNumber, whenText } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { useTriggersFor } from '@/lib/triggers'
import {
  callerChip,
  configText,
  credentialText,
  curlCommand,
  isMaskedPath,
  latencyText,
  messageStepText,
  parseBody,
  replayBlocked,
  replayRequest,
  tokenOfRequest,
  triggerOutcomeText,
  userChangeText,
} from '../activity'
import { AuthEmulatorError, callAuthEmulator } from '../api'
import { clientLabel } from '../clients'
import { copyToClipboard } from '@/lib/copy'
import { explainAuthError } from '../errors'
import { messageRef, userRef } from '../links'
import { callLabel } from '../operations'
import { activityEntryQuery } from '../queries'
import { SettingsLink } from './settings-link'

/** The Auth emulator's own address, as an app would call it: for curl. */
export function useAuthBase(): string | undefined {
  const status = useQuery(statusQuery)
  const data = status.data
  if (!data) return undefined
  const port = data.services.find((service) => service.name === 'auth')?.port
  if (port === undefined) return undefined
  return `http://${hostLiteral(defaultConnectHost(data).host)}:${port}`
}

export function ActivityDetail({
  project,
  id,
  loaded,
  capacity,
  bodiesRetained,
  replayAsk = 0,
  onClose,
  onPrev,
  onNext,
  onOpen,
  onInspect,
  onLogs,
  onOpenUser,
}: {
  project: string
  id: number
  /** The row as the feed holds it, shown at once while the rest is read. */
  loaded: AuthActivitySummary | undefined
  capacity: number
  bodiesRetained: boolean | undefined
  /** Bumped by `r` on a call that is not idempotent: the Replay button asks first. */
  replayAsk?: number | undefined
  onClose: () => void
  onPrev?: (() => void) | undefined
  onNext?: (() => void) | undefined
  /** Opens another call (the replay's new entry). */
  onOpen: (id: number) => void
  /** Opens Inspect a token with this token. */
  onInspect: (token: string) => void
  /** Opens this call's lines in Logs, when Logs is in this console. */
  onLogs: ((call: AuthActivitySummary) => void) | undefined
  onOpenUser: (call: AuthActivitySummary) => void
}) {
  const entry = useQuery(activityEntryQuery(project, id))
  const detail = entry.data
  const call = detail?.summary ?? loaded
  const gone = entry.error instanceof ApiError && entry.error.code === 'not-found'
  return (
    <Inspector
      widthKey="auth.call"
      title={
        call ? (
          <span className="flex min-w-0 items-center gap-1.5 text-[14px]" data-testid="call-title">
            <span className="shrink-0 font-semibold text-kumo-default">{callLabel(call)}</span>
            <span className="shrink-0 text-kumo-subtle">·</span>
            <span
              className={`min-w-0 truncate font-mono text-[12px] ${call.error ? 'text-kumo-danger' : 'text-kumo-subtle'}`}
            >
              {call.status}
              {call.error ? ` ${call.error.code}` : ''}
            </span>
          </span>
        ) : (
          <span className="font-mono text-[12px] text-kumo-subtle">Call #{formatNumber(id)}</span>
        )
      }
      meta={call ? latencyText(call.durationMicros) : undefined}
      onClose={onClose}
      closeLabel="Close the call"
      noun="call"
      onPrev={onPrev}
      onNext={onNext}
      footer={
        call ? (
          <DetailFooter
            call={call}
            detail={detail}
            bodiesRetained={bodiesRetained}
            replayAsk={replayAsk}
            onOpen={onOpen}
            onInspect={onInspect}
            onLogs={onLogs}
          />
        ) : undefined
      }
      testId="call-detail"
    >
      {call ? (
        <DetailBody
          call={call}
          detail={detail}
          bodiesRetained={bodiesRetained}
          onOpenUser={onOpenUser}
        />
      ) : gone ? (
        <p className="px-5 py-4 text-[13px] text-kumo-subtle" data-testid="call-gone">
          {entry.error instanceof ApiError
            ? entry.error.message
            : `The engine no longer keeps call #${formatNumber(id)}; it keeps the newest ${formatNumber(capacity)}.`}
        </p>
      ) : entry.error ? (
        <p className="px-5 py-4 text-[13px] text-kumo-danger">
          {entry.error instanceof Error ? entry.error.message : 'The call could not be read.'}
        </p>
      ) : null}
    </Inspector>
  )
}

function DetailBody({
  call,
  detail,
  bodiesRetained,
  onOpenUser,
}: {
  call: AuthActivitySummary
  detail: AuthActivityDetail | undefined
  bodiesRetained: boolean | undefined
  onOpenUser: (call: AuthActivitySummary) => void
}) {
  const client = clientLabel(call.client)
  const now = useNow('second')
  const facts: KeyValueItem[] = [
    { label: 'When', value: whenText(call.at, now), mono: false, testId: 'call-when' },
    {
      label: 'Caller',
      value: client ? `${callerChip(call)} · ${client.label}` : callerChip(call),
      mono: false,
      hint: client?.raw,
    },
    { label: 'Credential', value: credentialText(call.credential), mono: false },
    { label: 'Operation', value: call.operation, copy: call.operation },
    {
      label: 'Tenant',
      value: call.tenant ?? <span className="font-sans text-[13px] text-kumo-subtle">none</span>,
    },
  ]
  if (call.identifier)
    facts.push({ label: 'Identifier', value: call.identifier, copy: call.identifier })
  if (call.provider) facts.push({ label: 'Provider', value: call.provider })
  if (call.uid)
    facts.push({
      label: 'User',
      value: (
        <EntityLink
          entity={{ ...userRef(call.tenant, call.uid), label: call.uid }}
          testId="call-user"
        />
      ),
    })
  return (
    <>
      {call.error && <WhatWentWrong call={call} onOpenUser={onOpenUser} />}
      <InspectorSection title="What it caused" count={call.steps.length + call.moreSteps}>
        <ul className="m-0 grid list-none gap-2 p-0" data-testid="call-steps">
          {call.steps.map((step, index) => (
            // Steps are the call's, in the order they happened: their place is their identity.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={index} className="grid gap-0.5">
              <StepLine step={step} tenant={call.tenant} />
            </li>
          ))}
          {call.moreSteps > 0 && (
            <li className="text-[12px] text-kumo-subtle">
              and {formatNumber(call.moreSteps)} more the engine did not keep
            </li>
          )}
        </ul>
      </InspectorSection>
      <InspectorSection title="Details">
        <KeyValueList items={facts} testId="call-facts" />
      </InspectorSection>
      <Bodies call={call} detail={detail} bodiesRetained={bodiesRetained} />
    </>
  )
}

function WhatWentWrong({
  call,
  onOpenUser,
}: {
  call: AuthActivitySummary
  onOpenUser: (call: AuthActivitySummary) => void
}) {
  const error = call.error
  if (!error) return null
  const explained = explainAuthError(error.code)
  const refused = call.steps.find(
    (step): step is Extract<AuthStep, { kind: 'blocking' }> =>
      step.kind === 'blocking' && step.failure !== null,
  )
  return (
    <InspectorSection title="What went wrong" testId="call-wrong">
      <div className="grid gap-1.5">
        <p className="m-0 text-[13px] text-kumo-default">
          <span className="font-mono text-[12px] text-kumo-danger">{error.code}</span>
          <span className="text-kumo-subtle"> → the Web SDK reports </span>
          <span className="font-mono text-[12px]" data-testid="call-sdk-code">
            {explained.sdk}
          </span>
        </p>
        {refused?.failure ? (
          <p className="m-0 text-[13px] text-kumo-default" data-testid="call-function-message">
            {refused.function ?? refused.event} refused it: “{refused.failure.message}”
          </p>
        ) : explained.explanation ? (
          <p className="m-0 text-[13px] text-kumo-default" data-testid="call-explanation">
            {explained.explanation.what}
          </p>
        ) : (
          error.message !== error.code && (
            <p className="m-0 text-[13px] text-kumo-default">{error.message}</p>
          )
        )}
        {explained.explanation?.fix && (
          <p className="m-0 text-[12px] text-kumo-subtle" data-testid="call-fix">
            {explained.explanation.fix}
          </p>
        )}
        {explained.sdkMessage && (
          <p className="m-0 text-[12px] text-kumo-subtle">
            In the app: “Firebase: {explained.sdkMessage} ({explained.sdk}).”
          </p>
        )}
        {!refused && error.message !== error.code && error.message.startsWith(error.code) && (
          <p className="m-0 font-mono text-[12px] [overflow-wrap:anywhere] text-kumo-subtle">
            {error.message}
          </p>
        )}
        {((explained.explanation?.user && (call.uid || call.identifier)) ||
          explained.explanation?.settings) && (
          <div className="flex items-center gap-2">
            {explained.explanation?.user && (call.uid || call.identifier) && (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => onOpenUser(call)}
                data-testid="call-open-user"
              >
                Open user
              </Button>
            )}
            {explained.explanation?.settings && (
              <SettingsLink tenant={call.tenant} testId="call-settings" />
            )}
          </div>
        )}
      </div>
    </InspectorSection>
  )
}

/**
 * A lifecycle event the call queued, and the functions that listen to it
 * (compute's matcher; nothing is said of them while it does not know).
 */
function TriggerStep({
  step,
  tenant,
}: {
  step: Extract<AuthStep, { kind: 'trigger' }>
  tenant: string | null
}) {
  const answer = useTriggersFor('auth', tenant ?? '', step.event)
  const functions = typeof answer === 'object' ? answer.functions : []
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-kumo-default">
      <span className="font-mono text-[12px]">{step.event}</span>
      <span className={step.outcome.startsWith('failed') ? 'text-kumo-danger' : 'text-kumo-subtle'}>
        {triggerOutcomeText(step.outcome)}
      </span>
      {step.outcome === 'queued' &&
        functions.map((fn) => (
          <EntityLink
            key={`${fn.codebase}|${fn.functionId}`}
            entity={{
              kind: 'functions.function',
              key: fn.functionId,
              label: fn.functionId.replace(/^[a-z]+-[a-z]+\d+-/, ''),
            }}
          />
        ))}
    </span>
  )
}

function StepLine({ step, tenant }: { step: AuthStep; tenant: string | null }): ReactNode {
  switch (step.kind) {
    case 'blocking':
      return <BlockingStep step={step} />
    case 'trigger':
      return <TriggerStep step={step} tenant={tenant} />
    case 'message':
      return (
        <span className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-kumo-default">
          Sent {messageStepText(step)}
          <EntityLink entity={messageRef(step.id, `message #${formatNumber(step.id)}`)} />
        </span>
      )
    case 'messageUsed':
      return step.id === null ? (
        <span className="text-[13px] text-kumo-default">Used a code</span>
      ) : (
        <span className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-kumo-default">
          Used
          <EntityLink entity={messageRef(step.id, `message #${formatNumber(step.id)}`)} />
        </span>
      )
    case 'user':
      return (
        <span className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-kumo-default">
          {userChangeText(step)}
          <EntityLink entity={{ ...userRef(step.tenant, step.uid), label: step.uid }} />
        </span>
      )
    case 'usersCleared':
      return (
        <span className="text-[13px] text-kumo-default">
          Deleted every user of {step.tenant ? `tenant ${step.tenant}` : 'the project'}
        </span>
      )
    case 'config':
      return <span className="text-[13px] text-kumo-default">{configText(step)}</span>
  }
}

function BlockingStep({ step }: { step: Extract<AuthStep, { kind: 'blocking' }> }) {
  const [raw, setRaw] = useState(false)
  const lines: string[] = []
  if (step.changed.length > 0) lines.push(`changed ${step.changed.join(', ')}`)
  if (step.customClaims.length > 0) lines.push(`custom claims ${step.customClaims.join(', ')}`)
  if (step.sessionClaims.length > 0) lines.push(`session claims ${step.sessionClaims.join(', ')}`)
  return (
    <div className="grid gap-0.5" data-testid="call-blocking">
      <span className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-kumo-default">
        <span className="font-mono text-[12px]">{step.event}</span>
        {step.function && step.function !== step.event && (
          <span className="font-mono text-[12px] text-kumo-subtle">{step.function}</span>
        )}
        <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
          {latencyText(step.durationMicros)}
        </span>
        {step.invocation && (
          <EntityLink
            entity={{
              kind: 'functions.invocation',
              key: step.invocation,
              label: 'Open this invocation',
            }}
            testId="call-invocation"
          />
        )}
      </span>
      {lines.map((line) => (
        <span key={line} className="font-mono text-[12px] text-kumo-subtle">
          {line}
        </span>
      ))}
      {step.failure && (
        <>
          <span className="text-[13px] text-kumo-danger" data-testid="call-blocking-failure">
            {step.failure.status === null ? '' : `${step.failure.status} · `}
            {step.failure.message}
          </span>
          <span>
            <button
              type="button"
              className="rounded-sm text-[12px] text-kumo-link hover:underline focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
              onClick={() => setRaw((shown) => !shown)}
              aria-expanded={raw}
              data-testid="call-raw-toggle"
            >
              {raw ? 'Hide the raw error' : 'Show the raw error'}
            </button>
          </span>
          {raw && (
            <code className="rounded-md bg-kumo-tint px-2 py-1 font-mono text-[12px] [overflow-wrap:anywhere] text-kumo-default">
              {step.failure.raw}
            </code>
          )}
        </>
      )}
    </div>
  )
}

function Bodies({
  call,
  detail,
  bodiesRetained,
}: {
  call: AuthActivitySummary
  detail: AuthActivityDetail | undefined
  bodiesRetained: boolean | undefined
}) {
  if (!detail) return null
  const note =
    bodiesRetained === false
      ? 'Request bodies are not kept: the engine runs with --no-diagnostics.'
      : detail.bodiesDropped
        ? 'Its bodies were dropped to keep room for newer calls.'
        : undefined
  const query: KeyValueItem[] = detail.query.map((pair) => ({
    label: pair.name,
    value: pair.value,
    copy: pair.value,
  }))
  const headers: KeyValueItem[] = detail.headers.map((pair) => ({
    label: pair.name,
    value: pair.value,
    copy: pair.value,
  }))
  return (
    <>
      <InspectorSection title="Request">
        <div className="grid gap-2">
          <p className="m-0 font-mono text-[12px] [overflow-wrap:anywhere] text-kumo-default">
            <span className="text-kumo-subtle">{call.method}</span> {call.path}
          </p>
          {query.length > 0 && <KeyValueList items={query} testId="call-query" />}
          {note ? (
            <Text size="sm" variant="secondary">
              {note}
            </Text>
          ) : (
            <Body text={detail.request} bytes={detail.requestBytes} label="request" />
          )}
        </div>
      </InspectorSection>
      <InspectorSection title="Response">
        <div className="grid gap-2">
          <p className="m-0 font-mono text-[12px] text-kumo-subtle">{call.status}</p>
          {!note && <Body text={detail.response} bytes={detail.responseBytes} label="response" />}
        </div>
      </InspectorSection>
      <InspectorSection title="Headers" count={headers.length}>
        <KeyValueList items={headers} testId="call-headers" />
      </InspectorSection>
    </>
  )
}

function Body({ text, bytes, label }: { text: string | null; bytes: number; label: string }) {
  const body = parseBody(text)
  if (!body)
    return (
      <Text size="sm" variant="secondary">
        {bytes > 0 ? `${formatNumber(bytes)} bytes, not kept (over 16 KiB).` : 'No body.'}
      </Text>
    )
  if ('text' in body)
    return (
      <pre className="m-0 max-h-60 overflow-auto rounded-md bg-kumo-control p-2 font-mono text-[12px] whitespace-pre-wrap text-kumo-default ring ring-kumo-line">
        {body.text}
      </pre>
    )
  return (
    <JsonTree
      value={body.json}
      defaultDepth={2}
      mask={isMaskedPath}
      ariaLabel={`The ${label} body`}
      testId={`call-${label}-body`}
    />
  )
}

function DetailFooter({
  call,
  detail,
  bodiesRetained,
  replayAsk,
  onOpen,
  onInspect,
  onLogs,
}: {
  call: AuthActivitySummary
  detail: AuthActivityDetail | undefined
  bodiesRetained: boolean | undefined
  replayAsk: number
  onOpen: (id: number) => void
  onInspect: (token: string) => void
  onLogs: ((call: AuthActivitySummary) => void) | undefined
}) {
  const { labels } = useInspectorRoom()
  const base = useAuthBase()
  const token = detail ? tokenOfRequest(detail) : undefined
  return (
    <InspectorFooter
      tools={
        <>
          <ToolButton
            label="Copy as curl"
            icon={<TerminalWindowIcon />}
            labels={labels}
            disabled={!detail || !base || bodiesRetained === false}
            onClick={() => {
              if (detail && base)
                void copyToClipboard(curlCommand(detail, base), { what: 'the call as curl' })
            }}
            testId="call-curl"
          />
          {token && (
            <ToolButton
              label="Inspect this token"
              icon={<MagnifyingGlassIcon />}
              labels={false}
              onClick={() => onInspect(token)}
              testId="call-inspect-token"
            />
          )}
          {onLogs && (
            <ToolButton
              label="Open in Logs"
              icon={<FileTextIcon />}
              labels={false}
              onClick={() => onLogs(call)}
              testId="call-logs"
            />
          )}
        </>
      }
      primary={
        <ReplayButton
          detail={detail}
          bodiesRetained={bodiesRetained}
          ask={replayAsk}
          onOpen={onOpen}
        />
      }
    />
  )
}

function ToolButton({
  label,
  icon,
  labels,
  disabled = false,
  onClick,
  testId,
}: {
  label: string
  icon: ReactNode
  labels: boolean
  disabled?: boolean
  onClick: () => void
  testId: string
}) {
  return labels ? (
    <Button
      variant="ghost"
      size="sm"
      icon={icon}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {label}
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      shape="square"
      icon={icon}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    />
  )
}

/** Sends the call again and opens the new entry; asks first when it is not idempotent. */
function ReplayButton({
  detail,
  bodiesRetained,
  ask,
  onOpen,
}: {
  detail: AuthActivityDetail | undefined
  bodiesRetained: boolean | undefined
  /** Changes when `r` asks for a replay: the popover opens once the call is read. */
  ask: number
  onOpen: (id: number) => void
}) {
  const [asking, setAsking] = useState(false)
  const [asked, setAsked] = useState(ask)
  if (asked !== ask && detail?.replayEffect) {
    setAsked(ask)
    setAsking(true)
  }
  const replay = useReplay(onOpen)
  const blocked = detail ? replayBlocked(detail, bodiesRetained) : 'Reading the call…'
  const run = () => {
    if (!detail) return
    setAsking(false)
    replay.mutate(detail)
  }
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const button = (
    <Button
      ref={setAnchor}
      variant="secondary"
      size="sm"
      icon={<ArrowClockwiseIcon />}
      disabled={blocked !== undefined}
      title={blocked}
      loading={replay.isPending}
      onClick={() => {
        if (detail?.replayEffect) setAsking(true)
        else run()
      }}
      data-testid="call-replay"
    >
      Replay
    </Button>
  )
  if (!detail?.replayEffect) return button
  return (
    <>
      {button}
      <ConfirmPopover
        open={asking}
        onOpenChange={setAsking}
        title="Replay this call?"
        description={detail.replayEffect}
        confirm="Replay"
        anchor={anchor}
        run={run}
        testId="call-replay-ask"
      />
    </>
  )
}

/** A replay: the new call's id opens, whatever it answered; no answer at all is said in a toast. */
export function useReplay(onOpen: (id: number) => void) {
  return useMutation({
    mutationFn: async (detail: AuthActivityDetail) => {
      try {
        const answer = await callAuthEmulator(replayRequest(detail))
        return answer.activity
      } catch (error) {
        if (error instanceof AuthEmulatorError) return error.activity
        throw error
      }
    },
    onSuccess: (activity) => {
      if (activity !== undefined) onOpen(activity)
    },
    onError: (error) =>
      toast({
        key: 'auth.replay',
        title: 'The replay did not reach the emulator',
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      }),
  })
}
