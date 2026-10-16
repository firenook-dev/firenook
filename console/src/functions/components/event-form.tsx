// Test event, for a background function: test a trigger without wiring the
// flow, or do the real thing. The kind's own few fields (a document path
// and which change, an object, a message, a user, an event's data) build
// the envelope the official functions shell would post, shown before it is
// sent and editable by hand; Send posts it to the function alone and
// nothing is written. "Do it for real" writes the document, uploads the
// file, publishes the message, creates the user or publishes the event, and
// follows the invocation the real thing made.

import { Button, Input, Select, Text } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  FileArrowUpIcon,
  LightningIcon,
  PencilSimpleIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError, nativeFetch } from '@/api/client'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { InvocationSummary } from '@/api/generated/compute/InvocationSummary'
import type { PubsubOutgoingMessage } from '@/api/generated/messaging/PubsubOutgoingMessage'
import { statusQuery } from '@/api/queries'
import { JsonField, parseJsonText } from '@/components/console/json-field'
import { JsonView } from '@/components/console/json-view'
import { serviceAddress } from '@/components/console/request/address'
import { SendButton } from '@/components/console/request/send-button'
import { RequiresNotice } from '@/components/console/requires-notice'
import { sectionStatus } from '@/components/console/section-gate'
import { publishEvent } from '@/eventarc/api'
import { commit, firestoreScope } from '@/firestore/rest'
import type { RestValue } from '@/firestore/value'
import { identityUsersQuery } from '@/lib/identity'
import { publish as publishMessages } from '@/pubsub/api'
import { invocationQuery } from '../api'
import {
  type BackendDefinition,
  type EnvelopeOptions,
  type TestEnvelope,
  buildTestEvent,
  decodeFields,
  encodeFields,
  fitsPattern,
  relativePath,
  substituteParams,
  topicOf,
  triggerKind,
} from '../envelopes'
import { eventInvokeCommand } from '../invoke-command'
import { sendTestEvent } from '../invoke-stream'
import { type EventDraft, useRunDraft } from '../run-drafts'
import { lastSegment, statusReasonText } from '../trigger-text'
import {
  CopyAsMenu,
  FormRow,
  PausedWarning,
  RunAnswer,
  RunError,
  RunFooter,
  useNextInvocation,
} from './run-parts'
import { Sentence } from './summary-strip'

type Change = 'created' | 'updated' | 'deleted'

/** The Firestore change a definition listens for, or undefined for a write trigger (any of the three). */
export function fixedChange(eventType: string | undefined): Change | undefined {
  const tail = String(eventType ?? '')
    .replace(/\.withAuthContext$/, '')
    .split('.')
    .pop()
  if (tail === 'create' || tail === 'created') return 'created'
  if (tail === 'update' || tail === 'updated') return 'updated'
  if (tail === 'delete' || tail === 'deleted') return 'deleted'
  return undefined
}

/** A Firestore definition's document pattern, relative. */
export function documentPattern(definition: BackendDefinition): string | undefined {
  const event = definition.eventTrigger
  const pattern =
    definition.platform === 'gcfv2'
      ? (event?.eventFilterPathPatterns?.document ?? event?.eventFilters?.document)
      : event?.resource
  return pattern ? relativePath(pattern) : undefined
}

/** The event data a kind starts from, as the CLI's --event-data would hold it. */
export function startingData(
  kind: ReturnType<typeof triggerKind>,
  definition: BackendDefinition,
): string {
  switch (kind) {
    case 'firestore':
      return '{\n  "total": 12\n}'
    case 'storage':
      return '{\n  "name": "uploads/photo.png",\n  "contentType": "image/png",\n  "size": "1024"\n}'
    case 'auth':
      return '{\n  "uid": "u_test",\n  "email": "test@example.test",\n  "displayName": "Test User"\n}'
    case 'pubsub':
      return '{\n  "data": { "hello": "world" },\n  "attributes": {}\n}'
    default:
      return definition.eventTrigger?.channel ? '{\n  "name": "Ada"\n}' : '{}'
  }
}

/** The CLI's event data and options from the form's fields. */
export function eventInput(
  kind: ReturnType<typeof triggerKind>,
  definition: BackendDefinition,
  fields: Record<string, string>,
): { eventData: unknown; opts: EnvelopeOptions } | { problem: string } {
  const parsed = parseJsonText(fields.data ?? '')
  if (!parsed.ok) return { problem: 'The event data does not parse as JSON.' }
  const data = parsed.value
  if (kind !== 'firestore') return { eventData: data, opts: {} }
  const path = (fields.path ?? '').trim().replace(/^\/+/, '')
  if (path === '') return { problem: 'Name the document.' }
  const change =
    fixedChange(definition.eventTrigger?.eventType) ??
    (fields.change as Change | undefined) ??
    'created'
  const write = fixedChange(definition.eventTrigger?.eventType) === undefined
  let eventData: unknown = data
  if (change === 'updated') eventData = { before: data, after: data }
  else if (write && change === 'created') eventData = { before: null, after: data }
  else if (write && change === 'deleted') eventData = { before: data, after: null }
  return { eventData, opts: { resource: path } }
}

/** The REST fields of plain data for a real write (integers as the REST API writes them, strings). */
export function restFields(data: unknown): Record<string, RestValue> {
  return integersAsText(encodeFields(data)) as Record<string, RestValue>
}

function integersAsText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(integersAsText)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'integerValue' ? String(item) : integersAsText(item),
      ]),
    )
  return value
}

/**
 * A Pub/Sub function's message (`{data, attributes, orderingKey}`, data as
 * text or JSON) as Pub/Sub's own console publish takes it: the path the
 * Pub/Sub page's composer takes, so every subscriber of the topic gets it
 * and a refusal is the console's, never counted as the app's.
 */
export function publishBody(
  topic: string,
  value: unknown,
): { topic: string; messages: PubsubOutgoingMessage[] } {
  const message = (value ?? {}) as {
    data?: unknown
    attributes?: Record<string, string>
    orderingKey?: string
  }
  const text =
    message.data === undefined
      ? ''
      : typeof message.data === 'string'
        ? message.data
        : JSON.stringify(message.data)
  return {
    topic,
    messages: [
      {
        data: { text },
        attributes: message.attributes ?? {},
        orderingKey: message.orderingKey ?? null,
      },
    ],
  }
}

interface Run {
  started?: InvocationSummary | undefined
  finished?: InvocationSummary | undefined
  error?: { message: string; fix?: string | undefined } | undefined
  sending: boolean
}

export function EventForm({
  project,
  detail,
  prefill,
  onPrefilled,
  onOpenInvocation,
}: {
  project: string
  detail: FunctionDetail
  prefill?: string | undefined
  onPrefilled: () => void
  onOpenInvocation: (id: string) => void
}) {
  const summary = detail.summary
  const definition = detail.definition as BackendDefinition
  const kind = triggerKind(definition)
  const status = useQuery(statusQuery)
  const storage = serviceAddress('storage', status.data)?.origin
  const pattern = kind === 'firestore' ? documentPattern(definition) : undefined
  const [draft, setDraft] = useRunDraft<EventDraft>(project, summary.id, () => ({
    kind: 'event',
    fields: {
      data: startingData(kind, definition),
      ...(kind === 'firestore'
        ? { path: pattern ? substituteParams(pattern, undefined, () => 0) : '', change: 'created' }
        : {}),
    },
    envelope: '',
    edited: false,
  }))
  const [run, setRun] = useState<Run | null>(null)
  const [real, setReal] = useState<{
    said: string
    /** The invocation the real thing makes; null when it makes none. */
    matches: ((invocation: InvocationSummary) => boolean) | null
  } | null>(null)
  const awaited = useNextInvocation(summary.id, real?.matches ?? null)
  const file = useRef<HTMLInputElement>(null)

  const input = eventInput(kind, definition, draft.fields)
  let built: TestEnvelope | undefined
  let buildProblem: string | undefined
  if ('problem' in input) buildProblem = input.problem
  else
    try {
      built = buildTestEvent(definition, project, input.eventData, input.opts, { storage })
    } catch (error) {
      buildProblem = error instanceof Error ? error.message : String(error)
    }
  const edited = draft.edited ? parseJsonText(draft.envelope) : undefined
  const body = draft.edited ? (edited?.ok ? edited.value : undefined) : built?.body
  const problem = draft.edited
    ? edited?.ok
      ? undefined
      : 'The envelope does not parse as JSON.'
    : buildProblem
  const setFields = (patch: Record<string, string>) =>
    setDraft({ ...draft, fields: { ...draft.fields, ...patch } })

  // Edit and replay: the recorded event fills the envelope, then the param goes.
  const recorded = useQuery({
    ...invocationQuery(project, prefill ?? ''),
    enabled: prefill !== undefined && project !== '',
  })
  useEffect(() => {
    if (!prefill || !recorded.data) return
    const text = recorded.data.detail.request.body.text
    let envelope = text
    try {
      envelope = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // Kept as it was recorded.
    }
    setDraft({ ...draft, envelope, edited: true })
    onPrefilled()
    // Once per prefill.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, recorded.data])

  const send = async () => {
    if (problem || body === undefined) return
    setRun({ sending: true })
    setReal(null)
    try {
      const outcome = await sendTestEvent(
        summary.id,
        {
          body,
          headers: Object.entries(built?.headers ?? {}).map(([name, value]) => ({ name, value })),
        },
        {
          onFrame: (frame) => {
            if (frame.frame === 'started')
              setRun((current) => ({ ...current, sending: true, started: frame.invocation }))
            if (frame.frame === 'finished')
              setRun((current) => ({ ...current, sending: false, finished: frame.invocation }))
          },
        },
      )
      setRun((current) => ({
        ...current,
        sending: false,
        ...(outcome.failed ? { error: { message: outcome.failed } } : {}),
      }))
    } catch (error) {
      setRun({
        sending: false,
        error:
          error instanceof ApiError
            ? { message: error.message, fix: error.fix }
            : { message: String(error) },
      })
    }
  }

  const sections = status.data?.sections
  const ready = (id: 'firestore' | 'storage' | 'auth' | 'pubsub' | 'eventarc') =>
    sectionStatus(sections, id).state === 'ready'
  const data = 'problem' in input ? undefined : parseJsonText(draft.fields.data ?? '')

  const forReal = useMutation({
    // The answer below is the real thing's from now on, not an earlier test event's.
    onMutate: () => {
      setRun(null)
      setReal(null)
    },
    mutationFn: async (chosen?: File) => {
      const value = data?.ok ? data.value : undefined
      if (kind === 'firestore') {
        const path = (draft.fields.path ?? '').trim().replace(/^\/+/, '')
        const database = definition.eventTrigger?.eventFilters?.database ?? '(default)'
        const scope = firestoreScope({ project, database, identity: { kind: 'owner' } })
        const change =
          fixedChange(definition.eventTrigger?.eventType) ??
          (draft.fields.change as Change | undefined) ??
          'created'
        await commit(scope, [
          change === 'deleted'
            ? { delete: path }
            : { set: { path, fields: restFields(value ?? {}) } },
        ])
        return {
          said: `${change === 'deleted' ? 'Deleted' : 'Wrote'} \`${path}\`.`,
          matches: (invocation: InvocationSummary) =>
            invocation.cause.type === 'firestore' && invocation.cause.document === path,
        }
      }
      if (kind === 'storage') {
        if (!chosen) throw new Error('Choose a file to upload.')
        const bucket = summary.trigger.bucket ?? `${project}.appspot.com`
        const object =
          value &&
          typeof value === 'object' &&
          typeof (value as { name?: unknown }).name === 'string' &&
          (value as { name: string }).name !== 'uploads/photo.png'
            ? (value as { name: string }).name
            : chosen.name
        await nativeFetch(
          `/storage/native/v0/b/${encodeURIComponent(bucket)}/o?name=${encodeURIComponent(object)}&uploadType=media`,
          {
            method: 'POST',
            headers: {
              authorization: 'Bearer owner',
              'content-type': chosen.type || 'application/octet-stream',
            },
            body: chosen,
          },
        )
        return {
          said: `Uploaded \`gs://${bucket}/${object}\`.`,
          matches: (invocation: InvocationSummary) =>
            invocation.cause.type === 'storage' && invocation.cause.object === object,
        }
      }
      if (kind === 'auth') {
        const user = (value ?? {}) as Record<string, unknown>
        const remove =
          fixedChange(definition.eventTrigger?.eventType) === 'deleted' ||
          /delete/.test(definition.eventTrigger?.eventType ?? '')
        const uid = typeof user.uid === 'string' ? user.uid : undefined
        await nativeFetch(
          `/auth/identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(project)}/accounts${remove ? ':delete' : ''}`,
          {
            method: 'POST',
            headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
            body: JSON.stringify(
              remove
                ? { localId: uid }
                : {
                    localId: uid,
                    email: user.email,
                    displayName: user.displayName,
                    password: 'password1',
                  },
            ),
          },
        )
        return {
          said: `${remove ? 'Deleted' : 'Created'} the user \`${uid ?? String(user.email ?? '')}\`.`,
          matches: (invocation: InvocationSummary) =>
            invocation.cause.type === 'auth' && (uid === undefined || invocation.cause.uid === uid),
        }
      }
      if (kind === 'pubsub') {
        const topic = summary.trigger.topic ?? `projects/${project}/topics/${topicOf(definition)}`
        const result = await publishMessages(publishBody(topic, value))
        const messageId = result.messageIds[0] ?? ''
        if (result.functionsSkipped > 0)
          return {
            said: `Published message \`${messageId}\` to ${lastSegment(topic)}. Background triggers are paused, so no function received it.`,
            matches: null,
          }
        return {
          said: `Published message \`${messageId}\` to ${lastSegment(topic)}.`,
          matches: (invocation: InvocationSummary) =>
            invocation.cause.type === 'pubsub' && invocation.cause.messageId === messageId,
        }
      }
      const channel = definition.eventTrigger?.channel ?? ''
      const result = await publishEvent({
        channel,
        type: definition.eventTrigger?.eventType ?? '',
        source: 'console',
        subject: (draft.fields.subject ?? '').trim() || null,
        id: null,
        time: null,
        encoding: 'json',
        data: JSON.stringify(value ?? {}),
        attributes: {},
      })
      return {
        said: `Published event \`${result.event.id}\` on ${lastSegment(channel)}.`,
        matches: (invocation: InvocationSummary) =>
          invocation.cause.type === 'eventarc' && invocation.cause.event === result.event.id,
      }
    },
    onSuccess: (outcome) => setReal(outcome),
  })

  if (summary.status === 'ignored' || kind === 'database')
    return (
      <div className="px-5 py-4" data-testid="event-form-ignored">
        <Text size="sm">
          {summary.statusReason
            ? statusReasonText(summary.statusReason)
            : 'The emulator does not deliver events to this function.'}{' '}
          A test event would not reach it.
        </Text>
      </div>
    )

  const realLabel =
    kind === 'firestore'
      ? `Write ${(draft.fields.path ?? '').trim() || 'the document'}`
      : kind === 'storage'
        ? 'Upload a file…'
        : kind === 'auth'
          ? /delete/.test(definition.eventTrigger?.eventType ?? '')
            ? 'Delete the user'
            : 'Create the user'
          : kind === 'pubsub'
            ? `Publish to ${topicOf(definition)}`
            : kind === 'eventarc'
              ? `Publish on ${lastSegment(definition.eventTrigger?.channel ?? '')}`
              : undefined
  const realNeeds: 'firestore' | 'storage' | 'auth' | 'pubsub' | 'eventarc' | undefined =
    kind === 'firestore' || kind === 'storage' || kind === 'auth' || kind === 'pubsub'
      ? kind
      : kind === 'eventarc'
        ? 'eventarc'
        : undefined
  const realReady = realNeeds === undefined || realNeeds === 'eventarc' ? true : ready(realNeeds)
  const pubsubPrimary = kind === 'pubsub' && realReady

  const change = fixedChange(definition.eventTrigger?.eventType)
  const nothingWritten =
    kind === 'firestore'
      ? `Nothing is written to Firestore. Your function receives this event as if the document had been ${change ?? draft.fields.change ?? 'created'}.`
      : kind === 'storage'
        ? 'Nothing is uploaded. Your function receives this event as if the object had changed.'
        : kind === 'auth'
          ? 'No user is created or deleted. Your function receives this event as if it had been.'
          : kind === 'pubsub'
            ? 'Sent to this function only: other subscribers of the topic do not get it.'
            : 'Sent to this function only; nothing is published.'

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="event-form">
      <div className="grid shrink-0 gap-3 px-5 py-3">
        <PausedWarning />
        {kind === 'firestore' && (
          <>
            <FormRow
              label="Document"
              hint={
                pattern ? (
                  pattern &&
                  (draft.fields.path ?? '').trim() !== '' &&
                  !fitsPattern(pattern, (draft.fields.path ?? '').trim().replace(/^\/+/, '')) ? (
                    <span className="text-kumo-warning">
                      Does not match <span className="font-mono">{pattern}</span>: the event is
                      sent, but a real write here would not fire it.
                    </span>
                  ) : (
                    <>
                      Matches <span className="font-mono">{pattern}</span>
                    </>
                  )
                ) : undefined
              }
            >
              <Input
                size="sm"
                className="min-w-0 flex-1 font-mono"
                value={draft.fields.path ?? ''}
                onChange={(event) => setFields({ path: event.target.value })}
                placeholder={pattern ?? 'collection/document'}
                aria-label="Document path"
                spellCheck={false}
                data-testid="event-path"
              />
              <LoadDocument
                project={project}
                definition={definition}
                path={draft.fields.path ?? ''}
                onLoad={(text) => setFields({ data: text })}
              />
            </FormRow>
            <FormRow label="Event">
              {change ? (
                <span className="font-mono text-[12px] text-kumo-default">{change}</span>
              ) : (
                <Select
                  size="sm"
                  aria-label="Change"
                  value={draft.fields.change ?? 'created'}
                  onValueChange={(next) => setFields({ change: String(next) })}
                  items={[
                    { value: 'created', label: 'created' },
                    { value: 'updated', label: 'updated' },
                    { value: 'deleted', label: 'deleted' },
                  ]}
                  className="w-36 font-mono"
                />
              )}
            </FormRow>
          </>
        )}
        {kind === 'auth' && (
          <LoadUser project={project} onLoad={(text) => setFields({ data: text })} />
        )}
        {kind === 'eventarc' && (
          <FormRow
            label="Subject"
            hint="Used when you publish for real; a test event carries only the data."
          >
            <Input
              size="sm"
              className="min-w-0 flex-1 font-mono"
              value={draft.fields.subject ?? ''}
              onChange={(event) => setFields({ subject: event.target.value })}
              placeholder={summary.trigger.filters.subject ?? 'greetings/ada'}
              aria-label="Subject"
              spellCheck={false}
            />
          </FormRow>
        )}
        <div className="grid gap-1">
          <span className="text-[12px] text-kumo-subtle">
            {kind === 'firestore'
              ? 'Document data'
              : kind === 'pubsub'
                ? 'Message'
                : kind === 'storage'
                  ? 'Object'
                  : kind === 'auth'
                    ? 'User'
                    : 'Event data'}
          </span>
          <JsonField
            value={draft.fields.data ?? ''}
            onChange={(text) => setFields({ data: text })}
            minLines={4}
            maxLines={14}
            ariaLabel="Event data"
            testId="event-data"
          />
        </div>
        <div className="grid gap-1" data-testid="event-envelope">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-kumo-subtle">
              {draft.edited ? 'Envelope (edited)' : 'Envelope, as the functions shell builds it'}
            </span>
            {draft.edited ? (
              <Button
                variant="ghost"
                size="xs"
                icon={<ArrowCounterClockwiseIcon />}
                className="ml-auto"
                onClick={() => setDraft({ ...draft, edited: false })}
                data-testid="event-rebuild"
              >
                Rebuild from the form
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                icon={<PencilSimpleIcon />}
                className="ml-auto"
                disabled={!built?.body}
                onClick={() =>
                  setDraft({
                    ...draft,
                    envelope: JSON.stringify(built?.body ?? {}, null, 2),
                    edited: true,
                  })
                }
                data-testid="event-edit-envelope"
              >
                Edit
              </Button>
            )}
          </div>
          {draft.edited ? (
            <JsonField
              value={draft.envelope}
              onChange={(envelope) => setDraft({ ...draft, envelope })}
              minLines={8}
              maxLines={20}
              ariaLabel="Envelope"
              testId="event-envelope-json"
            />
          ) : built?.body ? (
            <div className="max-h-72 overflow-auto rounded-md ring ring-kumo-line">
              <JsonView value={built.body} height="content" raw={false} />
            </div>
          ) : null}
        </div>
        {problem && (
          <Text size="xs" variant="error">
            {problem}
          </Text>
        )}
        <Text size="xs" variant="secondary">
          {nothingWritten}
        </Text>
        {realLabel && (
          <div className="grid gap-1.5" data-testid="event-for-real">
            {realNeeds && realNeeds !== 'eventarc' && (
              <RequiresNotice
                section={realNeeds}
                for={realLabel}
                testId="event-for-real-requires"
              />
            )}
            {realReady && !pubsubPrimary && (
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-kumo-subtle">Do it for real:</span>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={kind === 'storage' ? <FileArrowUpIcon /> : <LightningIcon />}
                  loading={forReal.isPending}
                  disabled={problem !== undefined && kind !== 'storage'}
                  onClick={() =>
                    kind === 'storage' ? file.current?.click() : forReal.mutate(undefined)
                  }
                  data-testid="event-real"
                >
                  {realLabel}
                </Button>
                {kind === 'storage' && (
                  <input
                    ref={file}
                    type="file"
                    className="hidden"
                    aria-hidden
                    tabIndex={-1}
                    onChange={(event) => {
                      const chosen = event.target.files?.[0]
                      event.target.value = ''
                      if (chosen) forReal.mutate(chosen)
                    }}
                  />
                )}
              </div>
            )}
            {forReal.error && (
              <RunError
                message={
                  forReal.error instanceof Error ? forReal.error.message : String(forReal.error)
                }
                fix={forReal.error instanceof ApiError ? forReal.error.fix : undefined}
              />
            )}
            {real && (
              <p className="m-0 text-[13px] text-kumo-default" data-testid="event-real-result">
                <Sentence text={real.said} />{' '}
                {awaited || !real.matches ? null : (
                  <span className="text-kumo-subtle">Waiting for the invocation it causes…</span>
                )}
              </p>
            )}
          </div>
        )}
      </div>
      <RunFooter
        tools={
          <>
            <CopyAsMenu
              dialects={[
                draft.edited || 'problem' in input
                  ? {
                      id: 'cli',
                      label: 'firenook functions:invoke',
                      refused:
                        'functions:invoke builds its own envelope from --event-data; the edited envelope cannot be said that way.',
                    }
                  : {
                      id: 'cli',
                      label: 'firenook functions:invoke',
                      text: eventInvokeCommand({
                        name: summary.name,
                        region: summary.region,
                        eventData: input.eventData,
                        resource: input.opts.resource,
                      }),
                    },
                {
                  id: 'json',
                  label: 'the envelope as JSON',
                  text: body === undefined ? undefined : JSON.stringify(body, null, 2),
                },
              ]}
            />
          </>
        }
        primary={
          pubsubPrimary ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                loading={run?.sending ?? false}
                disabled={problem !== undefined}
                onClick={() => void send()}
                data-testid="event-send"
              >
                Send to this function only
              </Button>
              <SendButton
                label={realLabel ?? 'Publish'}
                onSend={() => forReal.mutate(undefined)}
                pending={forReal.isPending}
                disabled={problem !== undefined}
                testId="event-publish"
              />
            </>
          ) : (
            <SendButton
              label={kind === 'pubsub' ? 'Send to this function only' : 'Send test event'}
              onSend={() => void send()}
              pending={run?.sending ?? false}
              disabled={problem !== undefined}
              testId="event-send"
            />
          )
        }
      />
      {(run || awaited) && (
        <RunAnswer
          project={project}
          invocation={run?.started ?? awaited}
          finished={run?.finished ?? awaited}
          onOpen={onOpenInvocation}
        >
          {run?.error && <RunError message={run.error.message} fix={run.error.fix} />}
        </RunAnswer>
      )}
    </div>
  )
}

/** "Load": the stored document's data into the form, to start from real data. */
function LoadDocument({
  project,
  definition,
  path,
  onLoad,
}: {
  project: string
  definition: BackendDefinition
  path: string
  onLoad: (text: string) => void
}) {
  const [said, setSaid] = useState<string | undefined>()
  const load = useMutation({
    mutationFn: async () => {
      const database = definition.eventTrigger?.eventFilters?.database ?? '(default)'
      const response = await fetch(
        `/console/api/v1/firestore/v1/projects/${encodeURIComponent(project)}/databases/${encodeURIComponent(database)}/documents/${path.trim().replace(/^\/+/, '')}`,
        { headers: { authorization: 'Bearer owner', accept: 'application/json' } },
      )
      if (response.status === 404) throw new Error('No document is stored at that path.')
      if (!response.ok) throw new Error(`Firestore answered ${response.status}.`)
      const document = (await response.json()) as { fields?: unknown }
      return JSON.stringify(decodeFields(document.fields), null, 2)
    },
    onSuccess: (text) => {
      setSaid(undefined)
      onLoad(text)
    },
    onError: (error) => setSaid(error instanceof Error ? error.message : String(error)),
  })
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        loading={load.isPending}
        disabled={path.trim() === ''}
        onClick={() => load.mutate()}
        data-testid="event-load"
      >
        Load
      </Button>
      {said && <span className="shrink-0 text-[12px] text-kumo-danger">{said}</span>}
    </>
  )
}

/** "Start from a user": an Auth user's record fills the form. */
function LoadUser({ project, onLoad }: { project: string; onLoad: (text: string) => void }) {
  const [text, setText] = useState('')
  const users = useQuery({ ...identityUsersQuery(project, text.trim()), enabled: project !== '' })
  const status = useQuery(statusQuery)
  if (sectionStatus(status.data?.sections, 'auth').state !== 'ready') return null
  return (
    <FormRow label="Start from">
      <Select
        size="sm"
        aria-label="Start from a user"
        value=""
        placeholder="An Auth user…"
        onValueChange={(uid) => {
          const user = users.data?.find((entry) => entry.uid === uid)
          if (!user) return
          onLoad(
            JSON.stringify(
              {
                uid: user.uid,
                ...(user.email ? { email: user.email } : {}),
                ...(user.displayName ? { displayName: user.displayName } : {}),
              },
              null,
              2,
            ),
          )
        }}
        items={(users.data ?? []).map((user) => ({
          value: user.uid,
          label: user.email ?? user.displayName ?? user.uid,
        }))}
        className="min-w-0 flex-1"
      />
      <Input
        size="sm"
        className="w-36"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Search"
        aria-label="Search users"
      />
    </FormRow>
  )
}
