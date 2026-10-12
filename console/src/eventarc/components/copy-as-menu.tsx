// "Copy as" for an event: the Admin SDK call an app makes to publish it,
// a curl to the Eventarc emulator's own address, or the event as JSON —
// each carrying this event's type, subject, data and attributes, so what
// was tried here can be pasted into code or a test.

import { Button, DropdownMenu } from '@cloudflare/kumo'
import { BracketsCurlyIcon, CaretDownIcon, TerminalIcon, CodeIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { statusQuery } from '@/api/queries'
import { serviceAddress } from '@/components/console/request/address'
import { toast } from '@/lib/toasts'
import { type PublishDraft, adminSdkCode, curlCode, wireEvent } from '../publish'

/** A random id for an event the code publishes, as the engine would give it. */
function freshId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

/** This instant, as an event's time. */
function now(): string {
  return new Date().toISOString()
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast({ key: 'eventarc.copy-as', title: `Copied as ${what}`, tone: 'success' })
  } catch {
    toast({ key: 'eventarc.copy-as', title: 'Could not copy', tone: 'danger' })
  }
}

export function CopyAsMenu({
  draft,
  label = true,
  testId = 'copy-as',
}: {
  /** The event as the drawer holds it (a kept event goes through `draftFromEvent`). */
  draft: PublishDraft
  /** Show the word; a narrow footer keeps the glyph. */
  label?: boolean
  testId?: string
}) {
  const status = useQuery(statusQuery)
  const address = serviceAddress('eventarc', status.data)
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          label ? (
            <Button variant="ghost" size="sm" icon={<CodeIcon />} data-testid={testId}>
              <span className="flex items-center gap-1">
                Copy as
                <CaretDownIcon size={11} />
              </span>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<CodeIcon />}
              aria-label="Copy as"
              data-testid={testId}
            />
          )
        }
      />
      <DropdownMenu.Content align="start">
        <DropdownMenu.Item
          icon={CodeIcon}
          onClick={() => void copy(adminSdkCode(draft), 'Admin SDK code')}
          data-testid={`${testId}-admin`}
        >
          Admin SDK
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={TerminalIcon}
          disabled={!address}
          onClick={() => {
            if (address) void copy(curlCode(draft, address.origin, freshId(), now()), 'curl')
          }}
          data-testid={`${testId}-curl`}
        >
          curl to the Eventarc emulator
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={BracketsCurlyIcon}
          onClick={() =>
            void copy(JSON.stringify(wireEvent(draft, freshId(), now()), null, 2), 'JSON')
          }
          data-testid={`${testId}-json`}
        >
          The event as JSON
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
