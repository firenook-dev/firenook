// The Trigger tab: what makes this function run, said four ways. A
// sentence; the facts (event type, resource, pattern, filters, schedule,
// queue, blocking options, retry, timeout); the trigger keys the runtime
// registered it under; and "Which writes fire this?" — type a path, a
// bucket, a topic, an event type, and the engine's one matcher answers for
// every function of that service whether it fires and why not, before
// anything is written. The options the manifest declares that the
// emulator does not apply are listed as such, and the definition is there
// exactly as `/backends` serves it.

import { Button, Input, Select, Text } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { ApiError } from '@/api/client'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { FunctionMatchRequest } from '@/api/generated/compute/FunctionMatchRequest'
import { EntityLink } from '@/components/console/entity-link'
import { InspectorSection } from '@/components/console/inspector'
import { JsonView } from '@/components/console/json-view'
import { type KeyValueItem, KeyValueList } from '@/components/console/key-value-list'
import { StatusDot } from '@/components/kit'
import { formatDuration } from '@/lib/format'
import { matchQuery } from '../api'
import { generationText } from '../kinds'
import { blockingWords, channelName, lastSegment, triggerSentence } from '../trigger-text'
import { Sentence } from './summary-strip'

/** The facts of a trigger, only those its kind sets. */
export function triggerFacts(detail: FunctionDetail): KeyValueItem[] {
  const { summary } = detail
  const trigger = summary.trigger
  const items: KeyValueItem[] = []
  const add = (label: string, value: string | null | undefined, mono = true) => {
    if (value === null || value === undefined || value === '') return
    items.push({
      label,
      value,
      copy: value,
      mono,
      testId: `trigger-${label.toLowerCase().replaceAll(' ', '-')}`,
    })
  }
  add('Event type', trigger.eventType)
  add('Database', trigger.database)
  add(
    'Document',
    trigger.document
      ? `${trigger.document}${trigger.matchType ? ` (${trigger.matchType})` : ''}`
      : null,
  )
  add('Bucket', trigger.bucket)
  add('Topic', trigger.topic)
  add('Channel', trigger.channel)
  for (const [key, value] of Object.entries(trigger.filters)) add(`Filter ${key}`, value)
  for (const [key, value] of Object.entries(trigger.pathPatterns))
    if (key !== 'document') add(`Path ${key}`, value)
  add('Resource', trigger.resource && trigger.resource !== trigger.topic ? trigger.resource : null)
  add('Schedule', trigger.schedule)
  add('Time zone', trigger.timeZone)
  if (detail.taskQueue) {
    add('Queue', detail.taskQueue.queue)
    add('Retry config', JSON.stringify(detail.taskQueue.retryConfig))
    add('Rate limits', JSON.stringify(detail.taskQueue.rateLimits))
  }
  if (detail.blocking) {
    add('Blocking event', blockingWords(detail.blocking.event), false)
    const forwards = Object.entries(detail.blocking.forwards)
      .filter(([, on]) => on)
      .map(([name]) => name.replace(/Token$/, ' token').replace(/^id/, 'ID'))
    add('Forwards', forwards.length > 0 ? forwards.join(', ') : 'nothing', false)
  }
  if (trigger.invoker.length > 0) add('Invoker', trigger.invoker.join(', '))
  if (trigger.retry !== null) add('Retry', trigger.retry ? 'on' : 'off', false)
  add('Timeout', formatDuration(summary.timeoutSeconds * 1000), false)
  add('Entry point', summary.entryPoint)
  add('Generation', generationText(summary.platform), false)
  return items
}

/** A matcher's starting inputs for a function's own trigger: its pattern with wildcards filled. */
export function examplePath(pattern: string | null): string {
  if (!pattern) return ''
  return pattern.replace(/{([^/{}=]+)(=\*\*)?}/g, (_whole, name: string) => `${name}1`)
}

/** The full topic name for what was typed: a short name in this project, or a full name as typed. */
export function fullTopic(typed: string, project: string): string {
  const name = typed.trim()
  return name.startsWith('projects/') ? name : `projects/${project}/topics/${name}`
}

type MatcherKind = 'firestore' | 'storage' | 'auth' | 'pubsub' | 'eventarc' | 'tasks'

/** Which matcher a function's Trigger tab offers, if any. */
export function matcherFor(detail: FunctionDetail): MatcherKind | undefined {
  switch (detail.summary.kind) {
    case 'firestore':
      return 'firestore'
    case 'storage':
      return 'storage'
    case 'auth':
    case 'blocking':
      return 'auth'
    case 'pubsub':
    case 'schedule':
      return 'pubsub'
    case 'eventarc':
      return 'eventarc'
    case 'tasks':
      return 'tasks'
    default:
      return undefined
  }
}

const FIRESTORE_CHANGES = ['created', 'updated', 'deleted'] as const
const STORAGE_EVENTS = ['finalized', 'deleted', 'metadataUpdated', 'archived'] as const
const AUTH_EVENTS = ['create', 'delete', 'beforeCreate', 'beforeSignIn'] as const

/** The matcher's form, its request once it can ask, and its inputs. */
function useMatcher(detail: FunctionDetail, project: string) {
  const { summary } = detail
  const trigger = summary.trigger
  const [path, setPath] = useState(() => examplePath(trigger.document))
  const [change, setChange] = useState<(typeof FIRESTORE_CHANGES)[number]>(() => {
    const type = trigger.eventType ?? ''
    if (/update/.test(type)) return 'updated'
    if (/delete/.test(type)) return 'deleted'
    return 'created'
  })
  const [bucket, setBucket] = useState(trigger.bucket ?? '')
  const [storageEvent, setStorageEvent] = useState<(typeof STORAGE_EVENTS)[number]>(() => {
    const type = trigger.eventType ?? ''
    if (/delete/.test(type)) return 'deleted'
    if (/metadata/i.test(type)) return 'metadataUpdated'
    if (/archive/.test(type)) return 'archived'
    return 'finalized'
  })
  const [authEvent, setAuthEvent] = useState<(typeof AUTH_EVENTS)[number]>(() => {
    if (detail.blocking?.event === 'beforeSignIn') return 'beforeSignIn'
    if (detail.blocking) return 'beforeCreate'
    return /delete/.test(trigger.eventType ?? '') ? 'delete' : 'create'
  })
  const [topic, setTopic] = useState(() =>
    lastSegment(detail.schedule?.topic ?? trigger.topic ?? ''),
  )
  const [channel, setChannel] = useState(trigger.channel ?? '')
  const [eventType, setEventType] = useState(trigger.eventType ?? '')
  const [subject, setSubject] = useState(trigger.filters.subject ?? '')
  const [queue, setQueue] = useState(detail.taskQueue?.queue ?? '')

  const kind = matcherFor(detail)
  let request: FunctionMatchRequest | undefined
  if (kind === 'firestore' && path.trim() !== '')
    request = {
      service: 'firestore',
      database: trigger.database ?? '(default)',
      path: path.trim().replace(/^\/+/, ''),
      changes: [change],
    }
  if (kind === 'storage' && bucket.trim() !== '')
    request = { service: 'storage', bucket: bucket.trim(), events: [storageEvent] }
  if (kind === 'auth') request = { service: 'auth', tenant: null, events: [authEvent] }
  if (kind === 'pubsub' && topic.trim() !== '')
    request = { service: 'pubsub', topic: fullTopic(topic, project) }
  if (kind === 'eventarc' && channel.trim() !== '' && eventType.trim() !== '')
    request = {
      service: 'eventarc',
      channel: channel.trim(),
      eventType: eventType.trim(),
      attributes: subject.trim() === '' ? {} : { subject: subject.trim() },
    }
  if (kind === 'tasks' && queue.trim() !== '') request = { service: 'tasks', queue: queue.trim() }

  const fields: ReactNode = (() => {
    switch (kind) {
      case 'firestore':
        return (
          <Row>
            <Input
              size="sm"
              className="min-w-0 flex-1 font-mono"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={trigger.document ?? 'collection/document'}
              aria-label="Document path"
              spellCheck={false}
              data-testid="match-path"
            />
            <Choice
              value={change}
              values={FIRESTORE_CHANGES}
              onChange={setChange}
              label="Change"
              testId="match-change"
            />
          </Row>
        )
      case 'storage':
        return (
          <Row>
            <Input
              size="sm"
              className="min-w-0 flex-1 font-mono"
              value={bucket}
              onChange={(event) => setBucket(event.target.value)}
              placeholder="bucket"
              aria-label="Bucket"
              spellCheck={false}
              data-testid="match-bucket"
            />
            <Choice
              value={storageEvent}
              values={STORAGE_EVENTS}
              onChange={setStorageEvent}
              label="Event"
              testId="match-event"
            />
          </Row>
        )
      case 'auth':
        return (
          <Row>
            <Choice
              value={authEvent}
              values={AUTH_EVENTS}
              onChange={setAuthEvent}
              label="Auth event"
              testId="match-auth-event"
            />
          </Row>
        )
      case 'pubsub':
        return (
          <Row>
            <Input
              size="sm"
              className="min-w-0 flex-1 font-mono"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="topic"
              aria-label="Topic"
              spellCheck={false}
              data-testid="match-topic"
            />
          </Row>
        )
      case 'eventarc':
        return (
          <div className="grid gap-1.5">
            <Row>
              <Input
                size="sm"
                className="min-w-0 flex-1 font-mono"
                value={eventType}
                onChange={(event) => setEventType(event.target.value)}
                placeholder="event type"
                aria-label="Event type"
                spellCheck={false}
                data-testid="match-type"
              />
            </Row>
            <Row>
              <Input
                size="sm"
                className="min-w-0 flex-1 font-mono"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
                placeholder="channel"
                aria-label="Channel"
                spellCheck={false}
                data-testid="match-channel"
              />
              <Input
                size="sm"
                className="min-w-0 flex-1 font-mono"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="subject"
                aria-label="Subject"
                spellCheck={false}
                data-testid="match-subject"
              />
            </Row>
          </div>
        )
      case 'tasks':
        return (
          <Row>
            <Input
              size="sm"
              className="min-w-0 flex-1 font-mono"
              value={queue}
              onChange={(event) => setQueue(event.target.value)}
              placeholder="queue:project-region-name"
              aria-label="Queue"
              spellCheck={false}
              data-testid="match-queue"
            />
          </Row>
        )
      default:
        return null
    }
  })()
  return { kind, request, fields }
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 items-center gap-1.5">{children}</div>
}

function Choice<T extends string>({
  value,
  values,
  onChange,
  label,
  testId,
}: {
  value: T
  values: readonly T[]
  onChange: (value: T) => void
  label: string
  testId: string
}) {
  return (
    <Select
      size="sm"
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      items={values.map((entry) => ({ value: entry, label: entry }))}
      className="w-40 shrink-0 font-mono"
      data-testid={testId}
    />
  )
}

/** `value` once it has held still for `delayMs`. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

function Matcher({ detail, project }: { detail: FunctionDetail; project: string }) {
  const { kind, request, fields } = useMatcher(detail, project)
  const asked = useDebounced(request, 250)
  const answer = useQuery({
    ...matchQuery(project, asked ?? { service: 'tasks', queue: '' }),
    enabled: asked !== undefined && project !== '',
  })
  if (!kind) return null
  const title =
    kind === 'firestore'
      ? 'Which writes fire this?'
      : kind === 'storage'
        ? 'Which objects fire this?'
        : kind === 'pubsub'
          ? 'Which topics fire this?'
          : kind === 'eventarc'
            ? 'Which events reach this?'
            : kind === 'tasks'
              ? 'Which queues dispatch to this?'
              : 'Which Auth events run this?'
  const matches = answer.data?.matches ?? []
  return (
    <InspectorSection title={title} testId="trigger-matcher">
      <div className="grid gap-2">
        {fields}
        {answer.error ? (
          <Text variant="error" size="sm">
            {answer.error instanceof ApiError
              ? answer.error.message
              : 'The engine could not answer.'}
          </Text>
        ) : answer.data ? (
          <ul className="grid gap-1" data-testid="match-results">
            {!answer.data.backgroundEnabled && (
              <li className="text-[12px] text-kumo-warning">
                Background triggers are paused, so nothing fires until they resume.
              </li>
            )}
            {matches.length === 0 && (
              <li className="text-[13px] text-kumo-subtle">
                No function of this service listens here.
              </li>
            )}
            {matches.map((match) => (
              <li
                key={`${match.functionId}:${match.change ?? ''}`}
                className="grid gap-0.5"
                data-testid="match-row"
                data-fires={match.fires ? '' : undefined}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot
                    tone={match.fires ? 'success' : 'neutral'}
                    label={match.fires ? 'Fires' : 'Does not fire'}
                  />
                  <EntityLink
                    entity={{
                      ...match.function,
                      label:
                        match.function.label ?? match.functionId.replace(/^[a-z]+-[a-z]+\d+-/, ''),
                    }}
                  />
                  {match.change && (
                    <span className="font-mono text-[11px] text-kumo-subtle">{match.change}</span>
                  )}
                </span>
                <span className="pl-3.5 text-[12px] text-kumo-subtle">{match.reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </InspectorSection>
  )
}

export function TriggerTab({ detail, project }: { detail: FunctionDetail; project: string }) {
  const facts = triggerFacts(detail)
  const [showDefinition, setShowDefinition] = useState(false)
  return (
    <div className="flex flex-col" data-testid="trigger-tab">
      <InspectorSection title="Runs when">
        <p className="text-[13px] leading-5 text-kumo-default" data-testid="trigger-sentence">
          <Sentence text={triggerSentence(detail.summary)} />
          {detail.summary.trigger.channel ? (
            <span className="text-kumo-subtle">
              {' '}
              ({channelName(detail.summary.trigger.channel)})
            </span>
          ) : null}
        </p>
      </InspectorSection>
      <InspectorSection title="Trigger">
        <KeyValueList items={facts} testId="trigger-facts" />
      </InspectorSection>
      <InspectorSection title="Keys" count={detail.keys.length} testId="trigger-keys">
        <ul className="grid gap-1">
          {detail.keys.map((key) => (
            <li key={key.key} className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-[12px] text-kumo-default">{key.key}</span>
              {key.stale ? (
                <StatusDot tone="neutral" label="removed by a reload" />
              ) : key.enabled ? (
                <StatusDot tone="success" label="enabled" />
              ) : (
                <StatusDot tone="warning" label="paused" />
              )}
            </li>
          ))}
        </ul>
      </InspectorSection>
      <Matcher detail={detail} project={project} />
      <InspectorSection
        title="Declared, not emulated"
        count={detail.declared.length}
        testId="trigger-declared"
      >
        <ul className="grid gap-1.5">
          {detail.declared.map((option) => (
            <li key={option.name} className="grid gap-0.5">
              <span className="flex min-w-0 items-baseline gap-2 font-mono text-[12px]">
                <span className="text-kumo-default">{option.name}</span>
                <span className="truncate text-kumo-subtle">{JSON.stringify(option.value)}</span>
              </span>
              <span className="text-[12px] text-kumo-subtle">{option.note}</span>
            </li>
          ))}
        </ul>
      </InspectorSection>
      <InspectorSection
        title="Definition"
        action={
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={showDefinition}
            onClick={() => setShowDefinition((shown) => !shown)}
            data-testid="trigger-definition-toggle"
          >
            {showDefinition ? 'Hide' : 'Show as /backends serves it'}
          </Button>
        }
      >
        {showDefinition ? (
          <div className="max-h-[480px] min-h-40" data-testid="trigger-definition">
            <JsonView value={detail.definition} height="content" />
          </div>
        ) : undefined}
      </InspectorSection>
    </div>
  )
}
