// A subscription's settings (S12): what can change, saved with a mask of
// what did, and what cannot, read-only with the engine's reason beside it —
// the topic, ordering and the filter are fixed at creation, and the emulator
// cannot change an expiration policy (it never deletes an idle subscription
// either). Then deleting it.

import { Button, Checkbox, Input, Radio, Select, Switch } from '@cloudflare/kumo'
import { TrashIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errorText } from '@/lib/error-text'
import type { PubsubSubscription } from '@/api/generated/messaging/PubsubSubscription'
import type { PubsubUpdateSubscriptionBody } from '@/api/generated/messaging/PubsubUpdateSubscriptionBody'
import { CopyField } from '@/components/console/copy-button'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { deleteSubscription, updateSubscription } from '../api'
import { shortName } from '../names'
import { pubsubKeys } from '../queries'
import {
  type DurationUnit,
  RetentionField,
  durationSeconds,
  retentionProblem,
  splitDuration,
} from './retention-field'
import { Note, SettingsRow, SettingsSection } from './topic-settings'

/** The engine's bounds, said in its own terms when a value is outside them. */
export function ackDeadlineProblem(text: string): string | undefined {
  const value = Number(text)
  if (!Number.isInteger(value)) return 'Enter whole seconds.'
  if (value < 10 || value > 600) return 'The ack deadline is 10 to 600 seconds.'
  return undefined
}

export function maxDeliveriesProblem(text: string): string | undefined {
  const value = Number(text)
  if (!Number.isInteger(value)) return 'Enter a whole number.'
  if (value < 5 || value > 100) return 'Max deliveries is 5 to 100.'
  return undefined
}

export function backoffProblem(minimum: string, maximum: string): string | undefined {
  const low = Number(minimum)
  const high = Number(maximum)
  if (!Number.isFinite(low) || !Number.isFinite(high)) return 'Enter seconds.'
  if (low < 0 || low > 600 || high < 0 || high > 600) return 'Backoff is 0 to 600 seconds.'
  if (high < low) return 'The maximum backoff is at least the minimum.'
  return undefined
}

/** A URL a push subscription can deliver to, or why not. */
export function endpointProblem(text: string): string | undefined {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? undefined
      : 'The endpoint is an http or https URL.'
  } catch {
    return 'The endpoint is an http or https URL.'
  }
}

export function SubscriptionSettings({
  project,
  subscription,
  topics,
  onDeleted,
}: {
  project: string
  subscription: PubsubSubscription
  /** The project's topics (full names), for the dead-letter topic. */
  topics: readonly string[]
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const { summary } = subscription
  const [ack, setAck] = useState(String(subscription.ackDeadlineSeconds))
  const [push, setPush] = useState(subscription.pushEndpoint !== null)
  const [endpoint, setEndpoint] = useState(subscription.pushEndpoint ?? '')
  const [retainAcked, setRetainAcked] = useState(subscription.retainAcked)
  const retention = splitDuration(subscription.retentionSeconds)
  const [amount, setAmount] = useState(retention.amount)
  const [unit, setUnit] = useState<DurationUnit>(retention.unit)
  const [deadLetter, setDeadLetter] = useState(subscription.deadLetter !== null)
  const [deadTopic, setDeadTopic] = useState(subscription.deadLetter?.topic ?? '')
  const [maxDeliveries, setMaxDeliveries] = useState(
    String(subscription.deadLetter?.maxDeliveryAttempts ?? 5),
  )
  const [backoff, setBackoff] = useState(subscription.retry !== null)
  const [minBackoff, setMinBackoff] = useState(
    String(subscription.retry?.minimumBackoffSeconds ?? 10),
  )
  const [maxBackoff, setMaxBackoff] = useState(
    String(subscription.retry?.maximumBackoffSeconds ?? 600),
  )
  const [exactlyOnce, setExactlyOnce] = useState(summary.exactlyOnce)

  const seconds = durationSeconds(amount, unit)
  const problems = {
    ack: ackDeadlineProblem(ack),
    endpoint: push ? endpointProblem(endpoint) : undefined,
    retention: retentionProblem(seconds),
    deadLetter: deadLetter
      ? deadTopic === ''
        ? 'Choose the topic to dead-letter into.'
        : maxDeliveriesProblem(maxDeliveries)
      : undefined,
    retry: backoff ? backoffProblem(minBackoff, maxBackoff) : undefined,
  }
  const valid = Object.values(problems).every((problem) => problem === undefined)

  const mask: string[] = []
  if (Number(ack) !== subscription.ackDeadlineSeconds) mask.push('ackDeadline')
  if (
    push !== (subscription.pushEndpoint !== null) ||
    (push && endpoint !== subscription.pushEndpoint)
  )
    mask.push('push')
  if (retainAcked !== subscription.retainAcked) mask.push('retainAcked')
  if (seconds !== subscription.retentionSeconds) mask.push('retention')
  if (
    deadLetter !== (subscription.deadLetter !== null) ||
    (deadLetter &&
      (deadTopic !== subscription.deadLetter?.topic ||
        Number(maxDeliveries) !== subscription.deadLetter.maxDeliveryAttempts))
  )
    mask.push('deadLetter')
  if (
    backoff !== (subscription.retry !== null) ||
    (backoff &&
      (Number(minBackoff) !== subscription.retry?.minimumBackoffSeconds ||
        Number(maxBackoff) !== subscription.retry.maximumBackoffSeconds))
  )
    mask.push('retry')
  if (exactlyOnce !== summary.exactlyOnce) mask.push('exactlyOnce')

  const save = useMutation({
    mutationFn: () => {
      const body: PubsubUpdateSubscriptionBody = { name: summary.name, mask }
      if (mask.includes('ackDeadline')) body.ackDeadlineSeconds = Number(ack)
      if (mask.includes('push')) body.pushEndpoint = push ? endpoint : null
      if (mask.includes('retainAcked')) body.retainAcked = retainAcked
      if (mask.includes('retention')) body.retentionSeconds = seconds ?? null
      if (mask.includes('deadLetter'))
        body.deadLetter = deadLetter
          ? { topic: deadTopic, maxDeliveryAttempts: Number(maxDeliveries) }
          : null
      if (mask.includes('retry'))
        body.retry = backoff
          ? { minimumBackoffSeconds: Number(minBackoff), maximumBackoffSeconds: Number(maxBackoff) }
          : null
      if (mask.includes('exactlyOnce')) body.exactlyOnce = exactlyOnce
      return updateSubscription(body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: pubsubKeys.subscription(project, summary.name),
      })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topicDetails(project) })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topics(project) })
      toast({
        key: `pubsub-subscription-${summary.name}`,
        title: `Saved ${summary.id}`,
        tone: 'success',
      })
    },
  })

  const [deleting, setDeleting] = useState(false)
  const remove = useMutation({
    mutationFn: () => deleteSubscription({ name: summary.name }),
    onSuccess: () => {
      setDeleting(false)
      toast({
        key: `pubsub-subscription-${summary.name}`,
        title: `Deleted ${summary.id}`,
        tone: 'success',
      })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topics(project) })
      onDeleted()
    },
  })

  const changed = mask.length > 0
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="pubsub-subscription-settings">
      <div className="max-w-[640px] px-6 py-5">
        <SettingsSection title="Subscription">
          <SettingsRow label="Full name">
            <CopyField value={summary.name} className="text-[12px]" />
          </SettingsRow>
          <SettingsRow label="Topic">
            <span className="font-mono text-[12px]">{summary.topic ?? '_deleted-topic_'}</span>
            <Note>A subscription's topic cannot change.</Note>
          </SettingsRow>
          <SettingsRow label="Ordering">
            <span className="text-[12px]">{summary.ordering ? 'By ordering key' : 'Off'}</span>
            <Note>Message ordering is fixed when the subscription is created.</Note>
          </SettingsRow>
          <SettingsRow label="Filter">
            <span className="font-mono text-[12px] [overflow-wrap:anywhere]">
              {summary.filter ?? 'none'}
            </span>
            <Note>The emulator cannot change a filter; create a new subscription.</Note>
          </SettingsRow>
          <SettingsRow label="Expiration">
            <span className="text-[12px]">
              {subscription.expirationTtlSeconds === null
                ? 'Never'
                : `After ${formatNumber(Math.round(subscription.expirationTtlSeconds / 86_400))} days of no activity`}
            </span>
            <Note>
              The emulator cannot change the expiration policy; it never deletes an idle
              subscription either.
            </Note>
          </SettingsRow>
          <SettingsRow label="Labels">
            {Object.keys(subscription.labels).length === 0 ? (
              <span className="text-[12px] text-kumo-inactive">none</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {Object.entries(subscription.labels).map(([key, value]) => (
                  <span key={key} className="rounded bg-kumo-tint px-1 font-mono text-[11px]">
                    {key}={value}
                  </span>
                ))}
              </span>
            )}
            <Note>Labels are set when a subscription is created.</Note>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Delivery" testId="subscription-delivery">
          <SettingsRow label="Ack deadline">
            <span className="flex items-center gap-1.5">
              <Input
                size="sm"
                type="number"
                min={10}
                max={600}
                value={ack}
                onChange={(event) => setAck(event.target.value)}
                aria-label="Ack deadline in seconds"
                className="w-20 font-mono"
                data-testid="subscription-ack-deadline"
              />
              <span className="text-[12px] text-kumo-subtle">seconds (10–600)</span>
            </span>
            {problems.ack && <Note tone="danger">{problems.ack}</Note>}
          </SettingsRow>
          <SettingsRow label="Type">
            <Radio.Group
              value={push ? 'push' : 'pull'}
              onValueChange={(value) => setPush(value === 'push')}
              orientation="horizontal"
            >
              <Radio.Legend className="sr-only">Delivery type</Radio.Legend>
              <Radio.Item label="Pull" value="pull" />
              <Radio.Item label="Push" value="push" />
            </Radio.Group>
            {push && (
              <Input
                size="sm"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="http://localhost:9000/push"
                aria-label="Push endpoint"
                className="w-full font-mono"
                data-testid="subscription-endpoint"
              />
            )}
            {push && problems.endpoint && endpoint !== '' && (
              <Note tone="danger">{problems.endpoint}</Note>
            )}
            {push && (
              <Note>
                The emulator retries a failed push every second until it gets a 2xx, and never
                dead-letters it, as the official emulator does.
              </Note>
            )}
          </SettingsRow>
          <SettingsRow label="Exactly once">
            <Checkbox
              checked={exactlyOnce}
              onCheckedChange={(checked) => setExactlyOnce(Boolean(checked))}
              label="Acknowledge each message exactly once"
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Retention" testId="subscription-retention">
          <SettingsRow label="Keep unacked for">
            <RetentionField
              amount={amount}
              unit={unit}
              onChange={(nextAmount, nextUnit) => {
                setAmount(nextAmount)
                setUnit(nextUnit)
              }}
              label="Keep unacknowledged messages for"
              testId="subscription-retention-duration"
            />
            {problems.retention && <Note tone="danger">{problems.retention}</Note>}
          </SettingsRow>
          <SettingsRow label="Acknowledged">
            <Switch
              variant="neutral"
              checked={retainAcked}
              onCheckedChange={setRetainAcked}
              label="Keep acknowledged messages (for replay)"
            />
            {retainAcked && !subscription.retainAcked && (
              <Note>Messages acknowledged before now are not brought back.</Note>
            )}
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Dead letter" testId="subscription-dead-letter">
          <Switch
            variant="neutral"
            checked={deadLetter}
            onCheckedChange={setDeadLetter}
            label="Move a message elsewhere after too many deliveries"
          />
          {deadLetter && (
            <>
              <SettingsRow label="Topic">
                <Select
                  size="xs"
                  value={deadTopic}
                  onValueChange={(next) => setDeadTopic(String(next))}
                  placeholder="Choose a topic"
                  aria-label="Dead-letter topic"
                  className="h-6.5 w-full min-w-0"
                >
                  {topics.map((topic) => (
                    <Select.Option key={topic} value={topic}>
                      <span className="font-mono text-[12px]">{shortName(topic)}</span>
                    </Select.Option>
                  ))}
                </Select>
              </SettingsRow>
              <SettingsRow label="Max deliveries">
                <span className="flex items-center gap-1.5">
                  <Input
                    size="sm"
                    type="number"
                    min={5}
                    max={100}
                    value={maxDeliveries}
                    onChange={(event) => setMaxDeliveries(event.target.value)}
                    aria-label="Max deliveries"
                    className="w-20 font-mono"
                  />
                  <span className="text-[12px] text-kumo-subtle">(5–100)</span>
                </span>
              </SettingsRow>
              {problems.deadLetter && <Note tone="danger">{problems.deadLetter}</Note>}
            </>
          )}
        </SettingsSection>

        <SettingsSection title="Retry policy" testId="subscription-retry">
          <Radio.Group
            value={backoff ? 'backoff' : 'immediately'}
            onValueChange={(value) => setBackoff(value === 'backoff')}
            orientation="horizontal"
          >
            <Radio.Legend className="sr-only">Retry policy</Radio.Legend>
            <Radio.Item label="Immediately" value="immediately" />
            <Radio.Item label="With backoff" value="backoff" />
          </Radio.Group>
          {backoff && (
            <span className="flex items-center gap-1.5 text-[12px] text-kumo-subtle">
              min
              <Input
                size="sm"
                type="number"
                value={minBackoff}
                onChange={(event) => setMinBackoff(event.target.value)}
                aria-label="Minimum backoff in seconds"
                className="w-20 font-mono"
              />
              s · max
              <Input
                size="sm"
                type="number"
                value={maxBackoff}
                onChange={(event) => setMaxBackoff(event.target.value)}
                aria-label="Maximum backoff in seconds"
                className="w-20 font-mono"
              />
              s
            </span>
          )}
          {problems.retry && <Note tone="danger">{problems.retry}</Note>}
          <Note>
            Stored. A nacked message is redelivered at once, as the official emulator does.
          </Note>
        </SettingsSection>

        <div className="flex items-center gap-3 border-b border-kumo-line pb-5">
          <Button
            variant={changed && valid ? 'primary' : 'secondary'}
            disabled={!changed || !valid}
            loading={save.isPending}
            onClick={() => save.mutate()}
            data-testid="subscription-save"
          >
            Save
          </Button>
          {save.isError && <Note tone="danger">{errorText(save.error)}</Note>}
          {!changed && <Note>Nothing changed.</Note>}
        </div>

        <SettingsSection title="Danger" testId="subscription-danger">
          <div>
            <Button
              variant="ghost"
              icon={<TrashIcon className="text-kumo-danger" />}
              onClick={() => {
                remove.reset()
                setDeleting(true)
              }}
              data-testid="subscription-delete"
            >
              <span className="text-kumo-danger">Delete subscription…</span>
            </Button>
          </div>
        </SettingsSection>
      </div>
      <DangerConfirm
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${summary.id}`}
        description={
          <>
            A subscriber pulling from <span className="font-mono text-[0.9em]">{summary.id}</span>{' '}
            gets NOT_FOUND from now on.
          </>
        }
        consequences={[
          summary.counters.backlog === 0
            ? 'Nothing is waiting in it.'
            : `Its backlog of ${formatNumber(summary.counters.backlog)} ${summary.counters.backlog === 1 ? 'message' : 'messages'} goes with it.`,
          'The topic and its other subscriptions are not touched.',
        ]}
        {...(remove.isError ? { error: errorText(remove.error) } : {})}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        testId="subscription-delete-confirm"
      />
    </div>
  )
}
