// A push subscription's attempts (S10), live: one row per streak — the
// attempts of one message in a row with the same outcome — kept in place
// while the streak grows ("500 ×312 · since 5 m ago"), newest first. The
// engine replays the streaks it still keeps when the tab opens, then
// follows; `p` pauses, and a paused feed holds new streaks back while the
// ones on screen still count up.

import { Button, Tooltip, cn } from '@cloudflare/kumo'
import { CopyIcon, DownloadSimpleIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { PubsubPushStreak } from '@/api/generated/messaging/PubsubPushStreak'
import { EmptyState } from '@/components/console/empty-state'
import { FeedList, useFeedPending } from '@/components/console/feed-list'
import { PauseButton } from '@/components/console/pause-button'
import { RelativeTime } from '@/components/console/relative-time'
import { StatusDot } from '@/components/kit'
import { copyToClipboard } from '@/lib/copy'
import { formatNumber } from '@/lib/format'
import type { FeedStore } from '@/lib/live/feed-store'
import { toast } from '@/lib/toasts'
import { setPushConfig } from '../api'
import { pubsubKeys } from '../queries'

const streakKey = (streak: PubsubPushStreak) => streak.streak

/** "1", "1–312": the attempts a streak covers. */
export function attemptsText(
  streak: Pick<PubsubPushStreak, 'firstAttempt' | 'lastAttempt'>,
): string {
  return streak.firstAttempt === streak.lastAttempt
    ? formatNumber(streak.firstAttempt)
    : `${formatNumber(streak.firstAttempt)}–${formatNumber(streak.lastAttempt)}`
}

/** A streak's outcome: the status code, or the network error's first word. */
export function streakOutcome(streak: Pick<PubsubPushStreak, 'status' | 'error'>): {
  tone: 'success' | 'danger'
  word: string
} {
  if (streak.status !== null)
    return {
      tone: streak.status >= 200 && streak.status < 300 ? 'success' : 'danger',
      word: String(streak.status),
    }
  const code = streak.error?.match(/\b(E[A-Z]{3,})\b/)?.[1]
  return { tone: 'danger', word: code ?? 'error' }
}

/** "21 ms", "<1 ms", "1.2 s": how long the endpoint took. */
export function latencyText(milliseconds: number): string {
  if (milliseconds < 1) return '<1 ms'
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1000).toFixed(1)} s`
}

const GRID = 'grid grid-cols-[88px_64px_72px_96px_64px_minmax(0,1fr)] items-center gap-x-3 px-3'

const HEADER = (
  <div className={cn(GRID, 'whitespace-nowrap')}>
    <span>When</span>
    <span className="text-right">Message</span>
    <span className="text-right">Attempts</span>
    <span>Status</span>
    <span className="text-right">Took</span>
    <span className="truncate">Response or error</span>
  </div>
)

function StreakRow({ streak }: { streak: PubsubPushStreak }) {
  const outcome = streakOutcome(streak)
  const detail = streak.error ?? streak.response ?? ''
  return (
    <div className={cn(GRID, 'w-full font-mono text-[12px]')} data-streak={streak.streak}>
      <span className="font-sans text-kumo-subtle">
        <RelativeTime iso={streak.lastAt} />
      </span>
      <span className="text-right tabular-nums">{streak.messageId}</span>
      <span className="text-right tabular-nums" data-testid="push-attempts">
        {attemptsText(streak)}
      </span>
      <StatusDot tone={outcome.tone} label={outcome.word} testId="push-status" />
      <span className="text-right text-kumo-subtle tabular-nums">
        {latencyText(streak.latencyMs)}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-kumo-subtle">{detail}</span>
        {streak.count > 1 && (
          <span
            className="shrink-0 font-sans text-[11px] text-kumo-subtle"
            data-testid="push-count"
          >
            ×{formatNumber(streak.count)} · since <RelativeTime iso={streak.firstAt} />
          </span>
        )}
      </span>
    </div>
  )
}

function renderStreak(streak: PubsubPushStreak) {
  return <StreakRow streak={streak} />
}

function renderExpandedStreak(streak: PubsubPushStreak) {
  return (
    <pre className="m-0 max-h-60 overflow-auto border-t border-kumo-hairline bg-kumo-tint px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-kumo-default">
      {streak.error ?? streak.response ?? 'The endpoint answered with no body.'}
    </pre>
  )
}

export function PushFeed({
  store,
  subscriptionId,
  follow,
  onFollowChange,
  selected,
  onOpenMessage,
}: {
  store: FeedStore<PubsubPushStreak>
  subscriptionId: string
  follow: boolean
  onFollowChange: (follow: boolean) => void
  /** The open message's id: its streaks stay selected. */
  selected: string | undefined
  onOpenMessage: (id: string) => void
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selectedKey, setSelectedKey] = useState<string | undefined>()
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FeedList<PubsubPushStreak>
        ariaLabel={`Push attempts of ${subscriptionId}`}
        store={store}
        order="newest-first"
        rowHeight={32}
        rowKey={streakKey}
        renderRow={renderStreak}
        expanded={expanded}
        renderExpanded={renderExpandedStreak}
        onToggleExpanded={(key, open) =>
          setExpanded((current) => {
            const next = new Set(current)
            if (open) next.add(key)
            else next.delete(key)
            return next
          })
        }
        selectedKey={selected === undefined ? undefined : selectedKey}
        onSelect={(streak) => {
          setSelectedKey(streak.streak)
          onOpenMessage(streak.messageId)
        }}
        follow={follow}
        onFollowChange={onFollowChange}
        header={HEADER}
        empty={
          <EmptyState
            icon={UploadSimpleIcon}
            title="No push attempts yet"
            description={`Each message published to the topic is pushed to ${subscriptionId}'s endpoint; its attempts appear here as they happen.`}
            testId="pubsub-push-empty"
          />
        }
        testId="pubsub-push-feed"
      />
      <p
        className="m-0 shrink-0 border-t border-kumo-hairline px-3 py-1.5 text-[12px] text-kumo-subtle"
        data-testid="pubsub-push-note"
      >
        The emulator retries a failed push every second until it gets a 2xx, and never dead-letters
        it.
      </p>
    </div>
  )
}

/** Row two's end on Push: the endpoint, the switch to pull, and the pause. */
export function PushEnd({
  project,
  subscription,
  endpoint,
  store,
  paused,
  onPausedChange,
}: {
  project: string
  subscription: string
  endpoint: string
  store: FeedStore<PubsubPushStreak>
  paused: boolean
  onPausedChange: (paused: boolean) => void
}) {
  const pending = useFeedPending(store, paused, streakKey)
  const queryClient = useQueryClient()
  const toPull = useMutation({
    mutationFn: () => setPushConfig({ subscription, endpoint: null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: pubsubKeys.subscription(project, subscription),
      })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topics(project) })
    },
    onError: (error) =>
      toast({
        key: `pubsub-push-${subscription}`,
        title: 'Could not switch to pull',
        description: error.message,
        tone: 'danger',
      }),
  })
  return (
    <span className="ml-auto flex min-w-0 items-center gap-2">
      {/* Below xl the endpoint is in Settings: the switch and the pause keep their room. */}
      <span className="hidden min-w-0 items-center gap-1 text-[12px] text-kumo-subtle xl:flex">
        endpoint
        <span
          className="max-w-80 min-w-0 truncate font-mono text-kumo-default"
          title={endpoint}
          data-testid="push-endpoint"
        >
          {endpoint}
        </span>
        <Tooltip
          content="Copy the endpoint"
          render={
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              icon={<CopyIcon />}
              aria-label="Copy the endpoint"
              onClick={() => {
                void copyToClipboard(endpoint, { what: 'the endpoint' })
              }}
            />
          }
        />
      </span>
      <Button
        variant="secondary"
        size="sm"
        icon={<DownloadSimpleIcon />}
        loading={toPull.isPending}
        onClick={() => toPull.mutate()}
        data-testid="pubsub-push-to-pull"
      >
        Switch to pull
      </Button>
      <PauseButton
        paused={paused}
        pending={pending}
        onChange={onPausedChange}
        testId="pubsub-push-pause"
      />
    </span>
  )
}
