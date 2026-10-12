// The exact Storage event bodies this file produces now — finalize,
// metadataUpdate, delete; v1 and the v2 CloudEvent — built by the engine
// from the same code its dispatcher uses, copyable for a unit test; and,
// while Functions runs in the suite, the finalize or metadataUpdated event
// sent again without rewriting the file.

import { Button, Tabs } from '@cloudflare/kumo'
import { PaperPlaneTiltIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import type { StorageResendEvent } from '@/api/generated/storage/StorageResendEvent'
import { InspectorSection } from '@/components/console/inspector'
import { JsonView } from '@/components/console/json-view'
import { RequiresNotice } from '@/components/console/requires-notice'
import { OWNER_AUTHORIZATION } from '@/lib/identity'
import { toast } from '@/lib/toasts'
import { resendEvent } from '../../api'
import { eventsQuery } from '../../queries'

type EventName = 'finalize' | 'metadataUpdate' | 'delete'

const EVENT_LABELS: Record<EventName, string> = {
  finalize: 'Finalize',
  metadataUpdate: 'Metadata',
  delete: 'Delete',
}

/** What the toast says once an event went out again. */
export function resendSentence(event: StorageResendEvent, sent: boolean): string {
  const name = event === 'finalize' ? 'finalize' : 'metadataUpdated'
  return sent
    ? `Sent the ${name} event to the Functions emulator`
    : `The ${name} event was not sent: background triggers are paused`
}

export function EventPayloads({
  object,
  project,
  admin,
}: {
  object: StorageObjectDetail
  project: string
  admin: boolean
}) {
  const payloads = useQuery(eventsQuery(project, object.bucket, object.name, object.generation))
  const [event, setEvent] = useState<EventName>('finalize')
  const [version, setVersion] = useState<'v1' | 'v2'>('v1')
  const [sending, setSending] = useState<StorageResendEvent | null>(null)
  const send = async (which: StorageResendEvent) => {
    setSending(which)
    try {
      const result = await resendEvent(
        { bucket: object.bucket, name: object.name, event: which },
        { authorization: OWNER_AUTHORIZATION },
      )
      toast({
        key: 'storage-resend',
        title: resendSentence(which, result.sent),
        tone: result.sent ? 'success' : 'warning',
      })
    } catch (error) {
      toast({
        key: 'storage-resend',
        title: 'The event was not sent',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setSending(null)
    }
  }
  const body = payloads.data?.[event][version]
  return (
    <InspectorSection title="Storage events this file sends" testId="event-payloads">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            size="sm"
            variant="segmented"
            value={event}
            onValueChange={(next) => setEvent(next as EventName)}
            tabs={(Object.keys(EVENT_LABELS) as EventName[]).map((value) => ({
              value,
              label: EVENT_LABELS[value],
            }))}
          />
          <Tabs
            size="sm"
            variant="segmented"
            value={version}
            onValueChange={(next) => setVersion(next as 'v1' | 'v2')}
            tabs={[
              { value: 'v1', label: 'v1 JSON' },
              { value: 'v2', label: 'v2 CloudEvent' },
            ]}
          />
        </div>
        {payloads.isError ? (
          <p className="text-[13px] text-kumo-danger">{payloads.error.message}</p>
        ) : body === undefined ? (
          <div className="h-24 animate-pulse rounded-md bg-kumo-tint" />
        ) : (
          <JsonView value={body} height="content" testId="event-payload" />
        )}
        {payloads.data && !payloads.data.functions ? (
          <RequiresNotice section="functions" for="Sending Storage events" />
        ) : (
          payloads.data &&
          admin && (
            <div className="grid gap-1">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<PaperPlaneTiltIcon />}
                  loading={sending === 'finalize'}
                  onClick={() => void send('finalize')}
                  data-testid="resend-finalize"
                >
                  Send the finalize event again
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<PaperPlaneTiltIcon />}
                  loading={sending === 'metadataUpdate'}
                  onClick={() => void send('metadataUpdate')}
                  data-testid="resend-metadata"
                >
                  Send the metadataUpdated event again
                </Button>
              </div>
              <span className="text-[12px] text-kumo-subtle">
                Re-sends the event; the file is not rewritten.
              </span>
            </div>
          )
        )}
      </div>
    </InspectorSection>
  )
}
