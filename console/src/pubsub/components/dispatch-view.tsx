// The exact request a function received for a message (PS-09b): the
// CloudEvent or the legacy envelope compute recorded when it ran — or, once
// that record has gone (the engine keeps the newest 2,000 invocations), the
// same request rebuilt from the message and the target, and labelled so.
// Read only when it is opened: most deliveries are never looked into, and
// a body may be 256 KiB.

import { Text } from '@cloudflare/kumo'
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { PubsubFunctionMark } from '@/api/generated/messaging/PubsubFunctionMark'
import { useDelayedFlag } from '@/components/console/empty-state'
import { JsonView } from '@/components/console/json-view'
import { formatBytes } from '@/lib/format'
import { errorText } from '@/messaging/confirm-popover'
import { dispatchQuery } from '../queries'

/** The disclosure's words: what the request was to the function, by how far the delivery got. */
export function dispatchLabel(mark: PubsubFunctionMark): string {
  if (mark === 'queued') return 'Request it will receive'
  if (mark === 'skipped') return 'Request it would have received'
  return 'Request received'
}

/** The body as JSON when it is JSON (a CloudEvent, a legacy envelope), else undefined. */
export function dispatchJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

const DISPATCH_SHOWN = 256 * 1024

export function DispatchView({
  project,
  topic,
  messageId,
  functionId,
  eventId,
  mark,
  testId = 'dispatch',
}: {
  project: string
  topic: string
  messageId: string
  functionId: string
  /** The delivery's own event id: a run again carries its own. */
  eventId: string
  mark: PubsubFunctionMark
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  const query = useQuery({
    ...dispatchQuery(project, topic, messageId, functionId, eventId, mark),
    enabled: open,
  })
  const body = query.data
  // A fast answer never flashes a word first.
  const slow = useDelayedFlag(open && query.isPending)
  const json = body ? dispatchJson(body.body) : undefined
  return (
    <div className="grid gap-1" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((shown) => !shown)}
        aria-expanded={open}
        className="flex w-fit items-center gap-1 rounded-sm text-[12px] text-kumo-subtle hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
        data-testid={`${testId}-toggle`}
      >
        {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
        {dispatchLabel(mark)}
      </button>
      {open &&
        (query.isError ? (
          <Text variant="error" size="sm">
            {errorText(query.error)}
          </Text>
        ) : body ? (
          <div className="grid gap-1" data-testid={`${testId}-body`}>
            <p className="m-0 font-mono text-[11px] text-kumo-subtle">
              {body.contentType || 'no content type'}
            </p>
            {body.rebuilt && (
              <p className="m-0 text-[12px] text-kumo-subtle" data-testid={`${testId}-rebuilt`}>
                {mark === 'queued' || mark === 'skipped'
                  ? 'Built from the message and the function, as the emulator sends it.'
                  : 'Rebuilt from the message: the engine no longer keeps the record of this delivery.'}
              </p>
            )}
            {json !== undefined ? (
              <div className="overflow-hidden rounded-md ring ring-kumo-line">
                <JsonView value={json} text={body.body} height="content" />
              </div>
            ) : (
              <pre className="m-0 max-h-60 overflow-auto rounded-md bg-kumo-control px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap text-kumo-default [overflow-wrap:anywhere]">
                {body.body}
              </pre>
            )}
            {body.truncated && (
              <p className="m-0 text-[12px] text-kumo-subtle">
                The first {formatBytes(DISPATCH_SHOWN)} of the request.
              </p>
            )}
          </div>
        ) : slow ? (
          <p className="m-0 text-[12px] text-kumo-subtle">Reading…</p>
        ) : null)}
    </div>
  )
}
