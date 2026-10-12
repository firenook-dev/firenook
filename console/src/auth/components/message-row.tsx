// One row of the Inbox: 32 px like every list. The unread dot, the channel,
// who it went to, what it is for, and for an SMS the code itself — 14 px,
// the one larger value in the row, because it is what the developer reads
// off the screen and types into the app — with its copy button; then what
// became of it (used, returned, from saved state; unused says nothing), the
// tenant when every tenant is shown, the time, and the row's menu.

import { ChatTextIcon, EnvelopeSimpleIcon } from '@phosphor-icons/react'
import { memo } from 'react'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import { CopyStripButton } from '@/components/console/strip-button'
import { isSms, messageLabel, statusChip } from '../messages'
import { type FeedMenuHandle, FeedMenuRow } from './feed-menu'
import { FeedTime } from './feed-time'

/** The quiet chip recipe (the grid's type badge), a step darker on a lit row. */
export const QUIET_CHIP =
  'inline-flex h-4.5 shrink-0 items-center rounded bg-kumo-tint px-1 font-mono text-[11px] text-kumo-subtle group-hover/row:ink in-aria-selected:ink'

function MessageRowView({
  message,
  unread,
  showTenant,
  handle,
}: {
  message: AuthMessage
  /** Arrived since this browser last looked at the Inbox, and not opened since. */
  unread: boolean
  /** Every tenant is shown, so a tenant's message says whose it is. */
  showTenant: boolean
  handle: { readonly current: FeedMenuHandle }
}) {
  const sms = isSms(message)
  const chip = statusChip(message)
  const Glyph = sms ? ChatTextIcon : EnvelopeSimpleIcon
  return (
    <FeedMenuRow rowKey={String(message.id)} label={`Actions for ${message.to}`} handle={handle}>
      <span className="flex w-4 shrink-0 justify-center pl-1" aria-hidden={!unread}>
        {unread && (
          <span
            className="size-1.5 rounded-full bg-kumo-brand"
            role="img"
            aria-label="New"
            data-testid="unread-dot"
          />
        )}
      </span>
      <span className="flex w-6 shrink-0 justify-center text-kumo-subtle">
        <Glyph size={14} aria-label={sms ? 'SMS' : 'Email'} />
      </span>
      {/* Who and what shrink first; the code, the chips and the time keep
          their room, so nothing at the row's end is ever drawn over. */}
      <span
        className="min-w-24 flex-[3] basis-0 truncate pr-3 font-mono text-[12px] text-kumo-default"
        data-testid="message-to"
      >
        {message.to}
      </span>
      <span className="min-w-20 flex-[2] basis-0 truncate pr-3 text-[12px] text-kumo-default">
        {messageLabel(message)}
      </span>
      <span className="flex w-28 shrink-0 items-center gap-1 pr-3">
        {sms ? (
          <>
            <span
              className={`font-mono text-[14px] leading-none tabular-nums ${message.used ? 'text-kumo-subtle' : 'text-kumo-default'}`}
              data-testid="message-code"
            >
              {message.code}
            </span>
            {/* Copying never opens the row under the button. */}
            <span className="contents" onClick={(event) => event.stopPropagation()}>
              <CopyStripButton
                value={message.code}
                label={`Copy the code for ${message.to}`}
                title="Copy the code"
                tabIndex={-1}
                testId="message-copy-code"
              />
            </span>
          </>
        ) : null}
      </span>
      {/* Slots of fixed width, so every row's columns start where the
          rows above them do, whatever chips a row carries. */}
      <span className="flex w-20 shrink-0 justify-end pr-2">
        {chip && (
          <span className={QUIET_CHIP} data-testid="message-status">
            {chip}
          </span>
        )}
      </span>
      {showTenant && (
        <span className="hidden w-28 shrink-0 justify-end pr-2 @3xl:flex">
          {message.tenant && (
            <span className={`${QUIET_CHIP} max-w-full truncate`} data-testid="message-tenant">
              {message.tenant}
            </span>
          )}
        </span>
      )}
      <span className="flex shrink-0 justify-end pr-1">
        <FeedTime iso={message.at} className="text-right" />
      </span>
    </FeedMenuRow>
  )
}

export const MessageRow = memo(MessageRowView)
