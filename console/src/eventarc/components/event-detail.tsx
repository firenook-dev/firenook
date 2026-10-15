// One event in the inspector: its type and where it came from, the
// delivery trace (who it reached, who filtered it out and on what), its
// attributes, its data, and the event exactly as it arrived. Replay
// publishes it again (with a new id unless "Keep the id"); Edit and
// publish opens the drawer filled from it.

import { Button, Checkbox, Tooltip } from '@cloudflare/kumo'
import { ArrowCounterClockwiseIcon, CaretRightIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { EventarcEventView } from '@/api/generated/compute/EventarcEventView'
import type { EventarcSnapshot } from '@/api/generated/compute/EventarcSnapshot'
import { CopyButton } from '@/components/console/copy-button'
import { QueryError } from '@/components/console/empty-state'
import { EntityLink } from '@/components/console/entity-link'
import {
  Inspector,
  InspectorFooter,
  InspectorSection,
  InspectorTitle,
  useInspectorRoom,
} from '@/components/console/inspector'
import { JsonView } from '@/components/console/json-view'
import { KeyValueList } from '@/components/console/key-value-list'
import { RelativeTime } from '@/components/console/relative-time'
import { describeKey } from '@/lib/shortcuts'
import { formatBytes } from '@/lib/format'
import { eventQuery } from '../api'
import { draftFromEvent } from '../publish'
import { channelLabel, channelNamed, nearMisses } from '../topology'
import { EventCode } from './event-code'
import { DeliveryList, invocationFigure } from './delivery-list'

/** The width below which the footer's "Code" keeps only its glyph, px. */
const COPY_AS_LABEL_AT = 500

/** An event id's figure: `#212` for `a3f9c1-212`. */
export const eventFigure = invocationFigure

export function EventDetail({
  project,
  id,
  channels,
  keepId,
  onKeepIdChange,
  replaying,
  onReplay,
  onEdit,
  onUseType,
  onClose,
  onPrev,
  onNext,
}: {
  project: string
  id: string
  channels: EventarcSnapshot | undefined
  keepId: boolean
  onKeepIdChange: (keep: boolean) => void
  replaying: boolean
  /** The footer's Replay: the click is the confirmation. */
  onReplay: () => void
  onEdit: () => void
  /** Publish this event again with another type (an unheard event's suggestion). */
  onUseType: (view: EventarcEventView, type: string) => void
  onClose: () => void
  onPrev: (() => void) | undefined
  onNext: (() => void) | undefined
}) {
  const event = useQuery(eventQuery(project, id))
  const view = event.data
  const summary = view?.detail.summary
  return (
    <Inspector
      widthKey="eventarc.event"
      testId="event-detail"
      title={
        summary ? (
          <InspectorTitle value={summary.eventType} />
        ) : (
          <span className="font-mono text-[12px] text-kumo-subtle">{eventFigure(id)}</span>
        )
      }
      meta={
        summary ? <span className="font-mono text-[11px]">{eventFigure(summary.id)}</span> : null
      }
      actions={<CopyButton value={id} label="Copy the event id" testId="event-copy-id" />}
      onClose={onClose}
      closeLabel="Close the event"
      noun="event"
      onPrev={onPrev}
      onNext={onNext}
      footer={
        view ? (
          <EventFooter
            view={view}
            keepId={keepId}
            onKeepIdChange={onKeepIdChange}
            replaying={replaying}
            onReplay={onReplay}
            onEdit={onEdit}
          />
        ) : undefined
      }
    >
      {event.isError && !view ? (
        <QueryError error={event.error} onRetry={() => void event.refetch()} section="eventarc" />
      ) : view ? (
        <EventBody view={view} channels={channels} onUseType={(type) => onUseType(view, type)} />
      ) : null}
    </Inspector>
  )
}

function EventBody({
  view,
  channels,
  onUseType,
}: {
  view: EventarcEventView
  channels: EventarcSnapshot | undefined
  onUseType: (type: string) => void
}) {
  const { detail } = view
  const summary = detail.summary
  const [raw, setRaw] = useState(false)
  const channel = channels
    ? channelNamed(channels.channels, channels.native, summary.channel)
    : undefined
  const label = channelLabel(
    channel ?? {
      id: summary.channel.split('/').at(-1) ?? summary.channel,
      location: null,
      name: summary.channel,
    },
  )
  const heard = channel?.subscriptions.map((subscription) => subscription.eventType) ?? []
  const suggestions = summary.unheard ? nearMisses(summary.eventType, heard) : []
  const attributes = Object.entries(detail.attributes)
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-b border-kumo-line px-5 py-2 text-[12px] text-kumo-subtle"
        data-testid="event-origin"
      >
        <Tooltip
          content={summary.channel}
          render={
            <span className="font-mono">
              {label.id}
              {label.where ? ` · ${label.where}` : ''}
            </span>
          }
        />
        <span aria-hidden>·</span>
        <span>
          from{' '}
          {summary.publisher ? (
            <EntityLink
              entity={{
                kind: 'extensions.instance',
                key: summary.publisher,
                label: summary.publisher,
              }}
              testId="event-publisher"
            />
          ) : (
            <span className="font-mono">
              {summary.origin === 'app' ? (summary.source ?? 'an app') : summary.origin}
            </span>
          )}
        </span>
        <span aria-hidden>·</span>
        <RelativeTime iso={summary.receivedAt} className="text-[12px]" />
        {detail.replayOf && (
          <>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-1">
              replay of
              <EntityLink
                entity={{
                  kind: 'eventarc.event',
                  key: detail.replayOf,
                  label: eventFigure(detail.replayOf),
                }}
                testId="event-replay-of"
              />
            </span>
          </>
        )}
      </div>
      {summary.error && (
        <div
          className="border-b border-kumo-line bg-kumo-danger-tint px-5 py-2 text-[13px] text-kumo-default"
          role="alert"
          data-testid="event-error"
        >
          The emulator could not read this event: {summary.error}
        </div>
      )}
      <InspectorSection
        title="Deliveries"
        count={detail.deliveries.length > 0 ? detail.deliveries.length : undefined}
        testId="event-deliveries"
      >
        <DeliveryList
          deliveries={detail.deliveries}
          refs={view.deliveries}
          unheard={summary.unheard}
          eventType={summary.eventType}
          suggestions={suggestions}
          onUseType={onUseType}
        />
      </InspectorSection>
      <InspectorSection title="Attributes" count={attributes.length} testId="event-attributes">
        <KeyValueList
          items={attributes.map(([name, value]) => ({
            label: name,
            value,
            copy: value,
            testId: `event-attribute-${name}`,
          }))}
        />
      </InspectorSection>
      <InspectorSection
        title={`Data · ${detail.datacontenttype ?? 'no content type'} · ${formatBytes(detail.dataSize)}`}
        testId="event-data"
      >
        {detail.dataTruncated && (
          <p className="m-0 mb-1.5 text-[12px] text-kumo-warning">
            The data is longer than the engine keeps; only its start is shown.
          </p>
        )}
        {detail.data === null || detail.data === undefined ? (
          <span className="text-[12px] text-kumo-subtle">No data.</span>
        ) : typeof detail.data === 'string' ? (
          <pre className="m-0 max-h-80 overflow-auto rounded-md bg-kumo-control p-2 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-kumo-default">
            {detail.data}
          </pre>
        ) : (
          <JsonView value={detail.data} height="content" testId="event-data-json" />
        )}
      </InspectorSection>
      <section className="shrink-0 border-t border-kumo-line px-5 py-2" aria-label="Raw event">
        <button
          type="button"
          onClick={() => setRaw((open) => !open)}
          aria-expanded={raw}
          className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-[12px] text-kumo-subtle hover:ink hover:text-kumo-default"
          data-testid="event-raw-toggle"
        >
          <CaretRightIcon size={10} className={raw ? 'rotate-90' : undefined} />
          The event as it arrived
        </button>
        {raw && (
          <div className="mt-1.5">
            <JsonView value={detail.raw} height="content" testId="event-raw" />
          </div>
        )}
      </section>
    </>
  )
}

function EventFooter({
  view,
  keepId,
  onKeepIdChange,
  replaying,
  onReplay,
  onEdit,
}: {
  view: EventarcEventView
  keepId: boolean
  onKeepIdChange: (keep: boolean) => void
  replaying: boolean
  onReplay: () => void
  onEdit: () => void
}) {
  const { labels, width } = useInspectorRoom()
  const truncated = view.detail.dataTruncated
  return (
    <InspectorFooter
      testId="event-footer"
      tools={
        <>
          <EventCode
            draft={draftFromEvent(view)}
            label={width >= COPY_AS_LABEL_AT}
            testId="event-code"
          />
          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                Open the publish drawer filled from this event
                <kbd className="font-sans text-[10px] opacity-70">{describeKey('Shift+R')}</kbd>
              </span>
            }
            render={
              labels ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<PencilSimpleIcon />}
                  onClick={onEdit}
                  data-testid="event-edit"
                >
                  Edit and publish
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  icon={<PencilSimpleIcon />}
                  aria-label="Edit and publish"
                  onClick={onEdit}
                  data-testid="event-edit"
                />
              )
            }
          />
        </>
      }
      primary={
        <>
          <span className="shrink-0 text-[12px] whitespace-nowrap">
            <Checkbox
              checked={keepId}
              onCheckedChange={(checked) => onKeepIdChange(Boolean(checked))}
              label="Keep the id"
              data-testid="event-keep-id"
            />
          </span>
          <Tooltip
            content={
              truncated
                ? 'The engine kept only the start of its data, so it cannot publish it again.'
                : 'Publish it again on its channel'
            }
            render={
              <span className="flex">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ArrowCounterClockwiseIcon />}
                  onClick={onReplay}
                  loading={replaying}
                  disabled={truncated}
                  data-testid="event-replay"
                >
                  Replay
                </Button>
              </span>
            }
          />
        </>
      }
    />
  )
}
