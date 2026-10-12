// The Activity tab: this user's calls to the Auth emulator and the codes
// and links sent to them, newest first, from the engine's rings (`q:
// uid:<uid>`, filtered by the engine), and live while the tab is open — the
// two feeds subscribe only while it is mounted. At most 500 of each are
// held. A row opens its call or message where the section shows it.

import { cn } from '@cloudflare/kumo'
import { ChatTextIcon, EnvelopeSimpleIcon, LightningIcon } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import { statusQuery } from '@/api/queries'
import { OutcomeChip } from '@/components/console/outcome-chip'
import { useQuery } from '@tanstack/react-query'
import { formatClock, formatDuration, useClockFormat } from '@/lib/format'
import { type FeedStore, useFeed } from '@/lib/live/feed-store'
import { linkTo } from '@/lib/links'
import { filterValueText } from '@/lib/filter'
import { MESSAGE_KIND_LABELS } from '../fields'
import { callRef, messageRef, rulesDecisionsLink } from '../links'
import { useActivityFeed, useInboxFeed } from '../live'
import type { TenantScope } from '../tenant-scope'

/** The most calls, and the most messages, the tab holds. */
export const USER_ACTIVITY_CAPACITY = 500
const ROW = 32

/** An operation id in words: `identitytoolkit.accounts.signInWithPassword` → "Sign in with password". */
export function operationWords(operation: string): string {
  const last = operation.split(/[./:]/).findLast(Boolean) ?? operation
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : operation
}

type Entry =
  | { kind: 'call'; at: number; key: string; call: AuthActivitySummary }
  | { kind: 'message'; at: number; key: string; message: AuthMessage }

function itemsOf<T>(store: FeedStore<T>): T[] {
  const items: T[] = []
  for (let index = 0; index < store.size(); index += 1) {
    const row = store.at(index)
    if (row?.kind === 'item') items.push(row.item)
  }
  return items
}

/** Calls and messages in one list, newest first. */
export function mergeEntries(
  calls: readonly AuthActivitySummary[],
  messages: readonly AuthMessage[],
): Entry[] {
  const entries: Entry[] = [
    ...calls.map((call) => ({
      kind: 'call' as const,
      at: Date.parse(call.at) || 0,
      key: `call:${call.id}`,
      call,
    })),
    ...messages.map((message) => ({
      kind: 'message' as const,
      at: message.at ? Date.parse(message.at) || 0 : 0,
      key: `message:${message.id}`,
      message,
    })),
  ]
  return entries.toSorted((a, b) => b.at - a.at)
}

export function UserActivity({
  project,
  scope,
  uid,
}: {
  project: string
  /** The user's tenant, as the feeds name it. */
  scope: TenantScope
  uid: string
}) {
  'use no memo' // the stores are read while rendering, through their snapshots' versions
  const q = `uid:${filterValueText(uid)}`
  const feedScope: TenantScope = scope.kind === 'tenant' ? scope : { kind: 'project' }
  const calls = useActivityFeed({
    project,
    scope: feedScope,
    q,
    includeConsole: true,
    capacity: USER_ACTIVITY_CAPACITY,
  })
  const messages = useInboxFeed({ project, scope: feedScope, q, capacity: USER_ACTIVITY_CAPACITY })
  const callsVersion = useFeed(calls.store).version
  const messagesVersion = useFeed(messages.store).version
  const entries = mergeEntries(itemsOf(calls.store), itemsOf(messages.store))
  const status = useQuery(statusQuery)
  const firestore = status.data?.services.some((service) => service.name === 'firestore') === true
  const { format } = useClockFormat()
  const navigate = useNavigate()
  const scroller = useRef<HTMLDivElement>(null)
  // oxlint-disable-next-line react/incompatible-library -- the directive above opts this component out of the compiler
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    getItemKey: (index) => entries[index]?.key ?? index,
    overscan: 12,
  })
  const ready = calls.ready && messages.ready
  const decisions = rulesDecisionsLink(uid)
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="user-activity"
      data-version={`${callsVersion}.${messagesVersion}`}
    >
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-kumo-subtle" data-testid="user-activity-empty">
            {ready || calls.error || messages.error
              ? 'No calls or messages for this user since the engine started.'
              : 'Reading this user’s activity…'}
          </p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = entries[item.index]
              if (!entry) return null
              const link =
                entry.kind === 'call'
                  ? linkTo(callRef(entry.call.id))
                  : linkTo(messageRef(entry.message.id))
              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={!link}
                  onClick={() => {
                    if (link) void navigate({ to: link.to as never, search: link.search as never })
                  }}
                  className={cn(
                    'absolute inset-x-0 flex h-8 items-center gap-2 border-b border-kumo-hairline px-5 text-left text-[12px]',
                    link ? 'hover:ink' : 'cursor-default',
                  )}
                  style={{ top: item.start }}
                  data-testid="user-activity-row"
                  data-kind={entry.kind}
                >
                  <span className="w-[86px] shrink-0 font-mono tabular-nums text-kumo-subtle">
                    {entry.at ? formatClock(new Date(entry.at).toISOString(), format) : 'saved'}
                  </span>
                  {entry.kind === 'call' ? (
                    <CallLine call={entry.call} />
                  ) : (
                    <MessageLine message={entry.message} />
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-kumo-line px-5 py-2 text-[12px] text-kumo-subtle">
        <span>Since the engine started (the newest 10,000 calls).</span>
        {firestore && (
          <button
            type="button"
            onClick={() =>
              void navigate({ to: decisions.to as never, search: decisions.search as never })
            }
            className="text-kumo-link hover:underline"
            data-testid="user-rules-decisions"
          >
            Rules decisions for this user ↗
          </button>
        )}
      </footer>
    </div>
  )
}

function CallLine({ call }: { call: AuthActivitySummary }) {
  const blocking = call.steps.find((step) => step.kind === 'blocking')
  return (
    <>
      <LightningIcon size={13} className="shrink-0 text-kumo-subtle" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-sans text-kumo-default">
        {operationWords(call.operation)}
        {call.origin && (
          <span className="ml-1.5 rounded bg-kumo-tint px-1 font-mono text-[11px] text-kumo-subtle">
            {call.origin === 'write' ? 'console' : call.origin}
          </span>
        )}
      </span>
      {blocking?.kind === 'blocking' && blocking.function && (
        <span className="shrink-0 font-mono text-[11px] text-kumo-subtle">
          {blocking.function} {formatDuration(blocking.durationMicros / 1_000)}
        </span>
      )}
      <span className="shrink-0">
        <OutcomeChip
          word={call.error ? call.error.code : 'ok'}
          tone={call.error ? 'danger' : 'success'}
          mono={call.error !== null}
        />
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-kumo-subtle">
        {formatDuration(call.durationMicros / 1_000)}
      </span>
    </>
  )
}

function MessageLine({ message }: { message: AuthMessage }) {
  const Glyph = message.channel === 'sms' ? ChatTextIcon : EnvelopeSimpleIcon
  return (
    <>
      <Glyph size={13} className="shrink-0 text-kumo-subtle" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-sans text-kumo-default">
        {MESSAGE_KIND_LABELS[message.kind]}
        <span className="ml-1.5 font-mono text-[12px] text-kumo-subtle">{message.to}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-kumo-subtle">
        {message.used ? 'used' : message.delivery === 'returned' ? 'returned' : 'unused'}
      </span>
    </>
  )
}
