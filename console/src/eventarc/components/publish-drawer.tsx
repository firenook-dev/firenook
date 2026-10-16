// Publishing a custom event from the console, in the inspector: the
// channel and type (completed from what the channels publish and listen
// for), source and subject, the data as JSON or text, extension
// attributes, and the id and time when they matter. Under it, who the
// event would reach — asked of the engine's own matcher as it is typed, so
// a typo in the type or a filter that would keep it out shows before it
// is sent. Publish (⌘↵) sends it the way the Admin SDK does, so it takes
// exactly the path an app's event takes.

import { Input, Tabs, cn } from '@cloudflare/kumo'
import { CaretRightIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { EventarcSnapshot } from '@/api/generated/compute/EventarcSnapshot'
import { Completion, Completions } from '@/components/console/completions'
import { Inspector, InspectorFooter, useInspectorRoom } from '@/components/console/inspector'
import { JsonField } from '@/components/console/json-field'
import { KeyValueEditor } from '@/components/console/key-value-editor'
import { SendButton } from '@/components/console/request/send-button'
import { PanelTitle, StatusDot } from '@/components/kit'
import { functionShortName } from './delivery-list'
import { matchQuery } from '@/functions/api'
import {
  type PublishDraft,
  type PublishProblem,
  attributeProblem,
  matchRequest,
  publishProblems,
} from '../publish'
import { channelLabel } from '../topology'
import { EventCode } from './event-code'

/** A value that settles `delay` ms after it last changed: what the matcher is asked. */
function useSettled<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

/** A label over a field, as the drawer sets them: 12 px, quiet, sentence case. */
function Field({
  label,
  problem,
  children,
  testId,
}: {
  label: string
  problem?: PublishProblem | undefined
  children: React.ReactNode
  testId?: string
}) {
  return (
    <label className="grid min-w-0 gap-1" data-testid={testId}>
      <span className="text-[12px] text-kumo-subtle">{label}</span>
      {children}
      {problem && (
        <span
          className="text-[12px] text-kumo-danger"
          role="alert"
          data-testid={`${testId}-problem`}
        >
          {problem.message}
        </span>
      )}
    </label>
  )
}

/** An input that offers the values it knows as you type, and takes any other. */
function SuggestInput({
  value,
  onChange,
  suggestions,
  placeholder,
  invalid,
  ariaLabel,
  testId,
}: {
  value: string
  onChange: (value: string) => void
  suggestions: readonly { value: string; detail: string }[]
  placeholder: string
  invalid: boolean
  ariaLabel: string
  testId: string
}) {
  const anchor = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const needle = value.trim().toLowerCase()
  const shown = suggestions
    .filter((item) => item.value !== value && item.value.toLowerCase().includes(needle))
    .slice(0, 50)
  return (
    <div ref={anchor} className="min-w-0">
      <Input
        size="sm"
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }
        }}
        placeholder={placeholder}
        variant={invalid ? 'error' : 'default'}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        className="w-full font-mono"
        data-testid={testId}
      />
      {open && shown.length > 0 && (
        <Completions anchor={anchor} testId={`${testId}-suggestions`}>
          {shown.map((item) => (
            <Completion
              key={item.value}
              label={item.value}
              detail={item.detail}
              onPick={() => {
                onChange(item.value)
                setOpen(false)
              }}
            />
          ))}
        </Completions>
      )}
    </div>
  )
}

/** The channels the drawer offers: every one in use, the native one last. */
function channelSuggestions(snapshot: EventarcSnapshot | undefined) {
  if (!snapshot) return []
  return [...snapshot.channels, snapshot.native].map((channel) => {
    const label = channelLabel(channel)
    return { value: channel.name, detail: label.where ? `${label.id} · ${label.where}` : label.id }
  })
}

/** The types the drawer offers for a channel: who declares, allows or listens for each. */
function typeSuggestions(snapshot: EventarcSnapshot | undefined, channelName: string) {
  if (!snapshot) return []
  const channels = [...snapshot.channels, snapshot.native]
  const scoped = channels.filter((channel) => channel.name === channelName)
  const from = scoped.length > 0 ? scoped : channels
  const details = new Map<string, string>()
  for (const channel of from) {
    for (const subscription of channel.subscriptions)
      if (!details.has(subscription.eventType))
        details.set(
          subscription.eventType,
          `heard by ${subscription.functionId ? functionShortName(subscription.functionId) : 'a trigger'}`,
        )
    for (const publisher of channel.publishers)
      for (const declared of publisher.declared)
        if (!details.has(declared.type))
          details.set(
            declared.type,
            `${declared.allowed ? 'published' : 'declared'} by ${publisher.instanceId}`,
          )
  }
  return [...details.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([value, detail]) => ({ value, detail }))
}

export function PublishDrawer({
  project,
  draft,
  onChange,
  channels,
  pending,
  error,
  onPublish,
  onClose,
}: {
  project: string
  draft: PublishDraft
  onChange: (draft: PublishDraft) => void
  channels: EventarcSnapshot | undefined
  pending: boolean
  /** The engine's refusal of the last Publish. */
  error: { message: string; fix?: string | undefined } | undefined
  onPublish: () => void
  onClose: () => void
}) {
  const [advanced, setAdvanced] = useState(draft.id !== '' || draft.time !== '')
  const [touched, setTouched] = useState(false)
  const problems = publishProblems(draft)
  const shown = touched
    ? problems
    : problems.filter((problem) => problem.field === 'data' || problem.field === 'attributes')
  const problemOf = (field: PublishProblem['field']) =>
    shown.find((problem) => problem.field === field)
  const set = (patch: Partial<PublishDraft>) => onChange({ ...draft, ...patch })
  const request = useSettled(matchRequest(draft))
  const preview = useQuery({
    ...matchQuery(
      project,
      request ?? { service: 'eventarc', channel: '', eventType: '', attributes: {} },
    ),
    enabled: request !== undefined,
  })
  const publish = () => {
    setTouched(true)
    if (problems.length === 0) onPublish()
  }
  return (
    <Inspector
      widthKey="eventarc.event"
      testId="publish-drawer"
      title={<PanelTitle>Publish an event</PanelTitle>}
      onClose={onClose}
      closeLabel="Close the publish drawer"
      footer={<PublishFooter draft={draft} pending={pending} onPublish={publish} />}
    >
      <div className="grid gap-3.5 px-5 py-4">
        <Field label="Channel" problem={problemOf('channel')} testId="publish-channel">
          <SuggestInput
            value={draft.channel}
            onChange={(channel) => set({ channel })}
            suggestions={channelSuggestions(channels)}
            placeholder="projects/<project>/locations/<location>/channels/<id>"
            invalid={problemOf('channel') !== undefined}
            ariaLabel="Channel"
            testId="publish-channel-input"
          />
        </Field>
        <Field label="Type" problem={problemOf('type')} testId="publish-type">
          <SuggestInput
            value={draft.type}
            onChange={(type) => set({ type })}
            suggestions={typeSuggestions(channels, draft.channel)}
            placeholder="com.example.order.v1.paid"
            invalid={problemOf('type') !== undefined}
            ariaLabel="Type"
            testId="publish-type-input"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Source" problem={problemOf('source')} testId="publish-source">
            <Input
              size="sm"
              value={draft.source}
              onChange={(event) => set({ source: event.target.value })}
              variant={problemOf('source') ? 'error' : 'default'}
              aria-label="Source"
              spellCheck={false}
              autoComplete="off"
              className="w-full font-mono"
              data-testid="publish-source-input"
            />
          </Field>
          <Field label="Subject" testId="publish-subject">
            <Input
              size="sm"
              value={draft.subject}
              onChange={(event) => set({ subject: event.target.value })}
              placeholder="optional"
              aria-label="Subject"
              spellCheck={false}
              autoComplete="off"
              className="w-full font-mono"
              data-testid="publish-subject-input"
            />
          </Field>
        </div>
        <div className="grid gap-1.5" data-testid="publish-data">
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-kumo-subtle">Data</span>
            <Tabs
              size="sm"
              variant="segmented"
              value={draft.encoding}
              onValueChange={(next) => set({ encoding: next as PublishDraft['encoding'] })}
              tabs={[
                { value: 'json', label: 'JSON' },
                { value: 'text', label: 'Text' },
              ]}
            />
          </div>
          {draft.encoding === 'json' ? (
            <JsonField
              value={draft.data}
              onChange={(data) => set({ data })}
              minLines={3}
              maxLines={14}
              ariaLabel="Data"
              testId="publish-data-json"
            />
          ) : (
            <textarea
              value={draft.data}
              onChange={(event) => set({ data: event.target.value })}
              rows={4}
              spellCheck={false}
              aria-label="Data"
              className="min-h-20 w-full resize-y rounded-md bg-kumo-control px-2 py-1.5 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus"
              data-testid="publish-data-text"
            />
          )}
          {problemOf('data') && (
            <span className="text-[12px] text-kumo-danger" role="alert">
              {problemOf('data')?.message}
            </span>
          )}
        </div>
        <div className="grid gap-1">
          <KeyValueEditor
            label="Attributes"
            rows={draft.attributes}
            onChange={(attributes) => set({ attributes })}
            keyPlaceholder="name"
            validateKey={attributeProblem}
            testId="publish-attributes"
          />
        </div>
        <div className="grid gap-2">
          <button
            type="button"
            onClick={() => setAdvanced((open) => !open)}
            aria-expanded={advanced}
            className="-ml-1 flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-[12px] text-kumo-subtle hover:ink hover:text-kumo-default"
            data-testid="publish-advanced"
          >
            <CaretRightIcon size={10} className={advanced ? 'rotate-90' : undefined} />
            Advanced
            <span className="font-mono text-[11px]">
              id {draft.id === '' ? '(auto)' : draft.id} · time{' '}
              {draft.time === '' ? '(now)' : draft.time} · specversion 1.0
            </span>
          </button>
          {advanced && (
            <div className="grid grid-cols-2 gap-3 pl-4">
              <Field label="Id" testId="publish-id">
                <Input
                  size="sm"
                  value={draft.id}
                  onChange={(event) => set({ id: event.target.value })}
                  placeholder="a UUID, made for it"
                  aria-label="Id"
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full font-mono"
                />
              </Field>
              <Field label="Time" testId="publish-time">
                <Input
                  size="sm"
                  value={draft.time}
                  onChange={(event) => set({ time: event.target.value })}
                  placeholder="now, RFC 3339"
                  aria-label="Time"
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full font-mono"
                />
              </Field>
            </div>
          )}
        </div>
        <section
          className="grid gap-1.5 border-t border-kumo-line pt-3"
          aria-label="Will reach"
          data-testid="publish-preview"
        >
          <span className="text-[12px] text-kumo-subtle">Will reach</span>
          {request === undefined ? (
            <span className="text-[12px] text-kumo-subtle">
              Name a channel and a type to see who would get it.
            </span>
          ) : preview.data ? (
            preview.data.matches.length === 0 ? (
              <span className="text-[12px] text-kumo-warning" data-testid="publish-preview-nobody">
                No function listens for{' '}
                <span className="font-mono">
                  {request.service === 'eventarc' ? request.eventType : ''}
                </span>{' '}
                on this channel, so it would be recorded as unheard.
              </span>
            ) : (
              <ul className="m-0 grid list-none gap-1 p-0">
                {preview.data.matches.map((match) => (
                  <li
                    key={match.functionId}
                    className="flex min-w-0 items-start gap-2 text-[12px]"
                    data-testid="publish-preview-row"
                    data-function={match.functionId}
                    data-fires={match.fires ? '' : undefined}
                  >
                    <StatusDot
                      tone={match.fires ? 'success' : 'warning'}
                      label={functionShortName(match.functionId)}
                      className={cn(
                        'shrink-0 font-mono',
                        match.fires ? 'text-kumo-default' : undefined,
                      )}
                    />
                    <span className="min-w-0 break-words text-kumo-subtle">{match.reason}</span>
                  </li>
                ))}
                {!preview.data.backgroundEnabled && (
                  <li className="text-[12px] text-kumo-warning">
                    Background triggers are paused, so it would be recorded and no handler would
                    run.
                  </li>
                )}
              </ul>
            )
          ) : (
            <span className="text-[12px] text-kumo-subtle">Asking the engine…</span>
          )}
        </section>
        {error && (
          <div
            className="grid gap-1 rounded-md bg-kumo-danger-tint px-3 py-2"
            role="alert"
            data-testid="publish-error"
          >
            <span className="text-[13px] text-kumo-danger">{error.message}</span>
            {error.fix && <span className="text-[12px] text-kumo-default">{error.fix}</span>}
          </div>
        )}
      </div>
    </Inspector>
  )
}

function PublishFooter({
  draft,
  pending,
  onPublish,
}: {
  draft: PublishDraft
  pending: boolean
  onPublish: () => void
}) {
  const { labels } = useInspectorRoom()
  return (
    <InspectorFooter
      testId="publish-footer"
      tools={<EventCode draft={draft} label={labels} testId="publish-code" />}
      primary={
        <SendButton onSend={onPublish} pending={pending} label="Publish" testId="publish-send" />
      }
    />
  )
}
