// Replay (S15): send a subscription back to a time or a snapshot, or purge
// it. Before anything is done the dialog says what will come back and why
// (`seekSentence`, from the subscription's own settings); a purge asks
// again through `DangerConfirm`; the result names what is available and
// what is acknowledged after the seek, as the engine counts it.

import { Button, DatePicker, Dialog, Input, Popover, Radio, Select, Text } from '@cloudflare/kumo'
import { CalendarBlankIcon, XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errorText } from '@/lib/error-text'
import type { PubsubSubscription } from '@/api/generated/messaging/PubsubSubscription'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { seek } from '../api'
import { shortName } from '../names'
import { pubsubKeys, snapshotsQuery, topicQuery } from '../queries'
import { type SeekMode, seekResultText, seekSentence, seekTime } from '../seek-text'
import { useGeneration } from './create-topic-dialog'
import { topicSnapshots } from './snapshots-table'

const pad = (value: number) => String(value).padStart(2, '0')

/** `10:02:13`, local. */
export function timeOfDay(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `2026-10-12`, local. */
function dayText(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The instant `milliseconds` before now. */
function ago(milliseconds: number): Date {
  return new Date(Date.now() - milliseconds)
}

/** `10:01`, local, for a snapshot's time. */
function clockText(iso: string): string {
  const at = new Date(iso)
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function ReplayDialog({
  open,
  project,
  subscription,
  config,
  waiting,
  initialSnapshot,
  onOpenChange,
}: {
  open: boolean
  project: string
  /** The subscription's full name. */
  subscription: string
  config: PubsubSubscription
  /** Messages waiting now, for Purge. */
  waiting: number
  /** A snapshot chosen already (from the topic's Snapshots tab). */
  initialSnapshot?: string | undefined
  onOpenChange: (open: boolean) => void
}) {
  const generation = useGeneration(open)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="p-6">
        <ReplayForm
          key={generation}
          project={project}
          subscription={subscription}
          config={config}
          waiting={waiting}
          initialSnapshot={initialSnapshot}
          onClose={() => onOpenChange(false)}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function ReplayForm({
  project,
  subscription,
  config,
  waiting,
  initialSnapshot,
  onClose,
}: {
  project: string
  subscription: string
  config: PubsubSubscription
  waiting: number
  initialSnapshot: string | undefined
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const id = shortName(subscription)
  const topic = config.summary.topic
  const snapshots = useQuery(snapshotsQuery(project))
  const topicDetail = useQuery({ ...topicQuery(project, topic ?? ''), enabled: topic !== null })
  const choices = topic ? topicSnapshots(snapshots.data?.items, topic) : []

  const [mode, setMode] = useState<SeekMode>(initialSnapshot ? 'snapshot' : 'time')
  const [start] = useState(() => ago(60_000))
  const [day, setDay] = useState<Date>(start)
  const [time, setTime] = useState(timeOfDay(start))
  const [calendar, setCalendar] = useState(false)
  const [snapshot, setSnapshot] = useState(initialSnapshot ?? '')
  const [purging, setPurging] = useState(false)
  const chosen = choices.find((item) => item.name === snapshot)
  const at = seekTime(day, time)
  const timeValid = /^\d{1,2}:\d{2}(:\d{2})?$/.test(time) && !Number.isNaN(at.getTime())

  const goBack = (milliseconds: number) => {
    const next = ago(milliseconds)
    setDay(next)
    setTime(timeOfDay(next))
    setMode('time')
  }

  const replay = useMutation({
    mutationFn: () =>
      seek(
        mode === 'purge'
          ? { subscription, now: true }
          : mode === 'snapshot'
            ? { subscription, snapshot }
            : { subscription, time: at.toISOString() },
      ),
    onSuccess: (result) => {
      setPurging(false)
      toast({
        key: `pubsub-seek-${subscription}`,
        title:
          mode === 'purge'
            ? `Purged ${id}`
            : mode === 'snapshot'
              ? `Replayed ${id} to ${chosen?.id ?? shortName(snapshot)}`
              : `Replayed ${id} to ${timeOfDay(at)}`,
        description: seekResultText(result.available, result.acked),
        tone: 'success',
      })
      void queryClient.invalidateQueries({
        queryKey: pubsubKeys.subscriptionBacklog(project, subscription),
      })
      void queryClient.invalidateQueries({
        queryKey: pubsubKeys.subscription(project, subscription),
      })
      onClose()
    },
  })
  const ready = mode === 'purge' || (mode === 'snapshot' ? chosen !== undefined : timeValid)
  const sentence = seekSentence(mode, {
    retainAcked: config.retainAcked,
    waiting,
    topicRetentionSeconds: topicDetail.data?.retentionSeconds,
    snapshot: chosen
      ? { id: chosen.id, unacked: chosen.unacked, createdAt: chosen.createdAt }
      : undefined,
  })

  return (
    <>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!ready || replay.isPending) return
          if (mode === 'purge') {
            replay.reset()
            setPurging(true)
          } else replay.mutate()
        }}
        data-testid="replay"
      >
        <div className="flex items-start justify-between gap-4">
          <Dialog.Title className="text-lg font-semibold">Replay {id}</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
          />
        </div>
        <Radio.Group value={mode} onValueChange={(next) => setMode(next as SeekMode)}>
          <Radio.Legend className="sr-only">Replay to</Radio.Legend>
          <div className="grid gap-2">
            <Radio.Item label="To a time" value="time" data-testid="replay-mode-time" />
            <div className="grid gap-2 pl-6">
              <div className="flex flex-wrap items-center gap-2">
                <Popover open={calendar} onOpenChange={setCalendar}>
                  <Popover.Trigger
                    render={
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<CalendarBlankIcon />}
                        className="font-mono"
                        onClick={() => setMode('time')}
                        data-testid="replay-day"
                      >
                        {dayText(day)}
                      </Button>
                    }
                  />
                  <Popover.Content className="p-2" align="start">
                    <DatePicker
                      mode="single"
                      selected={day}
                      defaultMonth={day}
                      onChange={(next) => {
                        if (next) setDay(next)
                        setCalendar(false)
                      }}
                    />
                  </Popover.Content>
                </Popover>
                <Input
                  size="sm"
                  type="time"
                  step={1}
                  value={time}
                  onChange={(event) => {
                    setTime(event.target.value)
                    setMode('time')
                  }}
                  aria-label="Time of day"
                  aria-invalid={!timeValid}
                  className="w-40 font-mono"
                  data-testid="replay-time"
                />
              </div>
              <span className="flex flex-wrap items-center gap-1 text-[12px] text-kumo-subtle">
                {(
                  [
                    ['1 min', 60_000],
                    ['5 min', 300_000],
                    ['1 h', 3_600_000],
                  ] as const
                ).map(([label, milliseconds]) => (
                  <Button
                    key={label}
                    variant="ghost"
                    size="xs"
                    type="button"
                    onClick={() => goBack(milliseconds)}
                    data-testid={`replay-back-${label.replace(' ', '')}`}
                  >
                    {label} ago
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  size="xs"
                  type="button"
                  onClick={() => goBack(config.retentionSeconds * 1000)}
                  data-testid="replay-back-oldest"
                >
                  oldest kept
                </Button>
              </span>
            </div>
            <Radio.Item
              label="To a snapshot"
              value="snapshot"
              disabled={choices.length === 0}
              data-testid="replay-mode-snapshot"
            />
            <div className="flex items-center gap-2 pl-6">
              {choices.length === 0 ? (
                <span className="text-[12px] text-kumo-subtle">
                  No snapshot of {topic ? shortName(topic) : 'its topic'} yet.
                </span>
              ) : (
                <>
                  <Select
                    size="sm"
                    value={snapshot}
                    onValueChange={(next) => {
                      setSnapshot(String(next))
                      setMode('snapshot')
                    }}
                    aria-label="Snapshot"
                    renderValue={() => (
                      <span className="font-mono">{chosen?.id ?? 'Choose a snapshot'}</span>
                    )}
                    className="w-44"
                    data-testid="replay-snapshot"
                  >
                    {choices.map((item) => (
                      <Select.Option key={item.name} value={item.name}>
                        <span className="font-mono text-[12px]">{item.id}</span>
                      </Select.Option>
                    ))}
                  </Select>
                  {chosen && (
                    <span className="text-[12px] whitespace-nowrap text-kumo-subtle">
                      recorded {clockText(chosen.createdAt)}, {formatNumber(chosen.unacked)} unacked
                    </span>
                  )}
                </>
              )}
            </div>
            <Radio.Item
              label={`Purge — acknowledge everything waiting now (${formatNumber(waiting)} ${waiting === 1 ? 'message' : 'messages'})`}
              value="purge"
              data-testid="replay-mode-purge"
            />
          </div>
        </Radio.Group>
        <Text variant="secondary" size="sm">
          <span data-testid="replay-sentence">{sentence}</span>
        </Text>
        {replay.isError && !purging && (
          <p className="m-0 text-[13px] text-kumo-danger" data-testid="replay-error">
            {errorText(replay.error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={mode === 'purge' ? 'destructive' : 'primary'}
            type="submit"
            disabled={!ready}
            loading={replay.isPending && !purging}
            data-testid="replay-submit"
          >
            {mode === 'purge' ? 'Purge…' : 'Replay'}
          </Button>
        </div>
      </form>
      {/* Outside the form: a portal's submit still bubbles through React to it. */}
      <DangerConfirm
        open={purging}
        onOpenChange={setPurging}
        title={`Purge ${id}`}
        description={`Every message waiting at ${id} now is acknowledged, as if a subscriber had acked it.`}
        consequences={[
          config.retainAcked
            ? 'The subscription keeps acknowledged messages, so a replay to a time brings them back.'
            : 'The subscription does not keep acknowledged messages: only a snapshot taken before brings them back.',
        ]}
        {...(replay.isError ? { error: errorText(replay.error) } : {})}
        pending={replay.isPending}
        onConfirm={() => replay.mutate()}
        testId="replay-purge-confirm"
      />
    </>
  )
}
