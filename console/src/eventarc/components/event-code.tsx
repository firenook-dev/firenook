// An event as code: the Admin SDK call an app makes to publish it, a curl
// to the Eventarc emulator's own address, or the event as JSON — each
// carrying this event's type, subject, data and attributes, so what was
// tried here can be pasted into code or a test. The kit's `CodePopover`, as
// every section's "Code" is; the curl and the JSON get a fresh id and the
// time the popover opened, as the engine would give them.

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { statusQuery } from '@/api/queries'
import { CodePopover } from '@/components/console/code-popover'
import { serviceAddress } from '@/components/console/request/address'
import { codeTab } from '@/components/console/request/as-code'
import { type PublishDraft, adminSdkCode, curlCode, wireEvent } from '../publish'

/** A random id for an event the code publishes, as the engine would give it. */
function freshId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

/** A new id and this instant, for the event the code sends. */
function stamp(): { id: string; time: string } {
  return { id: freshId(), time: new Date().toISOString() }
}

export function EventCode({
  draft,
  label = true,
  testId,
}: {
  /** The event as the drawer holds it (a kept event goes through `draftFromEvent`). */
  draft: PublishDraft
  /** Show the word; a narrow footer keeps the glyph. */
  label?: boolean
  testId: string
}) {
  const status = useQuery(statusQuery)
  const address = serviceAddress('eventarc', status.data)
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(stamp)
  return (
    <CodePopover
      title="This event as code"
      kind="eventarc.event"
      tabs={[
        codeTab('node', adminSdkCode(draft)),
        ...(address ? [codeTab('curl', curlCode(draft, address.origin, sent.id, sent.time))] : []),
        {
          id: 'json',
          label: 'JSON',
          language: 'json',
          code: JSON.stringify(wireEvent(draft, sent.id, sent.time), null, 2),
        },
      ]}
      note={(tab) =>
        tab === 'curl'
          ? `To the Eventarc emulator at ${address?.origin ?? ''}, as an app's publish arrives.`
          : tab === 'node'
            ? 'With the Admin SDK, from a function or a script, as an extension publishes.'
            : undefined
      }
      label={label}
      open={open}
      onOpenChange={(next) => {
        if (next) setSent(stamp())
        setOpen(next)
      }}
      testId={testId}
    />
  )
}
