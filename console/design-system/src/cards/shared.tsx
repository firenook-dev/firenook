import { Text } from '@cloudflare/kumo'
import type { ReactNode } from 'react'
import { LEADER_LOCK, RELAY_CHANNEL, type RelayMessage } from '@/lib/live/leader'

/** A labelled row inside a card: the label sits left, the samples right. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-6">
      <div className="w-28 shrink-0 pt-1.5">
        <Text variant="secondary" size="sm">
          {label}
        </Text>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">{children}</div>
    </div>
  )
}

/** A card section: heading plus its rows, spaced as related text. */
export function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: ReactNode
}) {
  return (
    <section className="grid gap-4">
      <div className="grid gap-1">
        <Text variant="heading" as="h2">
          {title}
        </Text>
        {note ? <Text variant="secondary">{note}</Text> : null}
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  )
}

export function Stack({ children }: { children: ReactNode }) {
  return <div className="grid gap-8">{children}</div>
}

/** A colour swatch that shows the token, not a hex, so the design tool speaks Kumo. */
export function Swatch({
  token,
  className,
  label,
  text,
  ring = true,
}: {
  token: string
  className: string
  label?: string
  text?: string
  /** Off when the swatch shows a ring token of its own. */
  ring?: boolean
}) {
  return (
    <div className="grid w-36 gap-1.5">
      <div className={`h-14 rounded-lg ${ring ? 'ring ring-kumo-line' : ''} ${className}`}>
        {text ? (
          <div className={`flex h-full items-center justify-center text-sm ${text}`}>Aa</div>
        ) : null}
      </div>
      <div className="grid">
        <span className="font-mono text-[12px] text-kumo-default">{token}</span>
        {label ? (
          <Text variant="secondary" size="xs">
            {label}
          </Text>
        ) : null}
      </div>
    </div>
  )
}

let quiet = false

/**
 * For a card with no engine whose views subscribe to a live topic (a trigger
 * line holds `functions.events`): the card takes the live channel's leader
 * lock before any view subscribes, so the page is a follower that opens no
 * connection, and it answers the followers as a leader that is live,
 * accepts every subscription and has nothing to send. Call it from the
 * card's providers, before their children render.
 */
export function quietLiveChannel() {
  if (quiet || !navigator.locks || typeof BroadcastChannel === 'undefined') return
  quiet = true
  void navigator.locks.request(LEADER_LOCK, () => new Promise<void>(() => undefined))
  const relay = new BroadcastChannel(RELAY_CHANNEL)
  // A BroadcastChannel reaches this origin's own tabs only; it takes no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  const send = (message: RelayMessage) => relay.postMessage(message)
  relay.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as RelayMessage
    if (message.t === 'who') {
      send({
        t: 'hello',
        leader: 'card',
        instance: 'card-engine',
        consoleBuild: 'design-system',
        engineRevision: null,
      })
      send({ t: 'status', leader: 'card', status: 'live' })
      return
    }
    if (message.t === 'sub') send({ t: 'accepted', subs: [message.id] })
  })
}
