// One row of the Inbox: 32 px like every list, on one grid template so the
// columns line up down the list. The unread dot, the channel,
// who it went to, what it is for, and for an SMS the code itself — 14 px,
// the one larger value in the row, because it is what the developer reads
// off the screen and types into the app — with its copy button; then what
// became of it (used, returned, from saved state; unused says nothing), the
// tenant when every tenant is shown, the time, and the row's menu.

import { ChatTextIcon, EnvelopeSimpleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo'
import { memo } from 'react'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import { CopyStripButton } from '@/components/console/strip-button'
import { isSms, messageLabel, statusChip } from '../messages'
import { type FeedMenuHandle, FeedMenuRow } from './feed-menu'
import { FeedTime } from './feed-time'

/**
 * The Inbox row's columns: the unread dot, the channel, who it went to and
 * what it is for (these two share what is left, 3 : 2), the code with its
 * copy button, what became of it, and the time (wide enough for the clock
 * form, `14:02:11.348`, and for "saved state"). With every tenant shown and
 * room for it, a tenant column sits before the time.
 */
const MESSAGE_COLUMNS = 'grid-cols-[16px_24px_minmax(96px,3fr)_minmax(120px,2fr)_96px_92px_92px]'
const MESSAGE_COLUMNS_TENANT =
  '@3xl:grid-cols-[16px_24px_minmax(96px,3fr)_minmax(120px,2fr)_96px_92px_112px_92px]'

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
      {/* One grid template for every row, so each column starts where the
          rows above it do whatever a row carries: an unread dot, a code, a
          chip, a tenant, the time in any clock form or "saved state". */}
      <span
        className={cn(
          'grid h-full min-w-0 flex-1 items-center',
          showTenant ? `${MESSAGE_COLUMNS} ${MESSAGE_COLUMNS_TENANT}` : MESSAGE_COLUMNS,
        )}
        data-testid="message-columns"
      >
        <span className="flex justify-center pl-1" aria-hidden={!unread}>
          {unread && (
            <span
              className="size-1.5 rounded-full bg-kumo-brand"
              role="img"
              aria-label="New"
              data-testid="unread-dot"
            />
          )}
        </span>
        <span className="flex justify-center text-kumo-subtle">
          <Glyph size={14} aria-label={sms ? 'SMS' : 'Email'} />
        </span>
        <span
          className="min-w-0 truncate pr-3 font-mono text-[12px] text-kumo-default"
          data-testid="message-to"
        >
          {message.to}
        </span>
        <span
          className="min-w-0 truncate pr-3 text-[12px] text-kumo-default"
          data-testid="message-kind"
        >
          {messageLabel(message)}
        </span>
        <span className="flex min-w-0 items-center gap-1 pr-3">
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
        <span className="flex min-w-0 justify-end pr-2">
          {chip && (
            <span className={QUIET_CHIP} data-testid="message-status">
              {chip}
            </span>
          )}
        </span>
        {showTenant && (
          <span className="hidden min-w-0 justify-end pr-2 @3xl:flex">
            {message.tenant && (
              <span className={`${QUIET_CHIP} max-w-full truncate`} data-testid="message-tenant">
                {message.tenant}
              </span>
            )}
          </span>
        )}
        <span className="flex min-w-0 justify-end pr-1">
          <FeedTime iso={message.at} className="min-w-0 truncate text-right" />
        </span>
      </span>
    </FeedMenuRow>
  )
}

export const MessageRow = memo(MessageRowView)
