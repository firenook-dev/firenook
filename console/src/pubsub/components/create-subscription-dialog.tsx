// New subscription (S14, 720 px): every option the emulator implements, in
// two columns — how it delivers on one side, what it receives on the other
// — with the filter checked by the engine's parser as it is typed and tried
// on the topic's recent messages ("passes 412 of the last 5,000"). Options
// the emulator stores but does not apply say so where they are set. Values
// outside the engine's bounds are flagged before the request, in its words.

import { Button, Checkbox, Dialog, Input, Radio, Select, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { errorText } from '@/lib/error-text'
import type { PubsubCreateSubscriptionBody } from '@/api/generated/messaging/PubsubCreateSubscriptionBody'
import { type KeyValueRow, KeyValueEditor } from '@/components/console/key-value-editor'
import { createSubscription, createTopic } from '../api'
import { fullName, idProblem, shortName } from '../names'
import { pubsubKeys } from '../queries'
import { AttributesFilterField, FilterCheckLine, useFilterCheck } from './attributes-filter-field'
import { Fold, useGeneration } from './create-topic-dialog'
import {
  type DurationUnit,
  RetentionField,
  durationSeconds,
  retentionProblem,
} from './retention-field'
import {
  ackDeadlineProblem,
  backoffProblem,
  endpointProblem,
  maxDeliveriesProblem,
} from './subscription-settings'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1">
      <Text variant="secondary" size="sm" as="span">
        {label}
      </Text>
      {children}
    </div>
  )
}

function Problem({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span className="text-[12px] text-kumo-danger" data-testid={testId}>
      {children}
    </span>
  )
}

export function CreateSubscriptionDialog({
  open,
  project,
  topic,
  topics,
  initialFilter,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  project: string
  /** The topic's full name. */
  topic: string
  /** The project's topics (full names), for the dead-letter topic. */
  topics: readonly string[]
  /** The message list's attributes expression, carried across. */
  initialFilter?: string | undefined
  onOpenChange: (open: boolean) => void
  onCreated: (subscription: string) => void
}) {
  const generation = useGeneration(open)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6 sm:w-[720px]">
        <CreateSubscriptionForm
          key={generation}
          project={project}
          topic={topic}
          topics={topics}
          initialFilter={initialFilter ?? ''}
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function CreateSubscriptionForm({
  project,
  topic,
  topics,
  initialFilter,
  onClose,
  onCreated,
}: {
  project: string
  topic: string
  topics: readonly string[]
  initialFilter: string
  onClose: () => void
  onCreated: (subscription: string) => void
}) {
  const queryClient = useQueryClient()
  const topicId = shortName(topic)
  const [id, setId] = useState('')
  const [touched, setTouched] = useState(false)
  const [push, setPush] = useState(false)
  const [endpoint, setEndpoint] = useState('')
  const [ack, setAck] = useState('10')
  const [filter, setFilter] = useState(initialFilter)
  const [ordering, setOrdering] = useState(false)
  const [exactlyOnce, setExactlyOnce] = useState(false)
  const [retainAcked, setRetainAcked] = useState(false)
  const [amount, setAmount] = useState('7')
  const [unit, setUnit] = useState<DurationUnit>('days')
  const [expires, setExpires] = useState(false)
  const [ttlDays, setTtlDays] = useState('31')
  const [deadLetter, setDeadLetter] = useState(false)
  const [deadTopic, setDeadTopic] = useState('')
  const [maxDeliveries, setMaxDeliveries] = useState('5')
  const [backoff, setBackoff] = useState(false)
  const [minBackoff, setMinBackoff] = useState('10')
  const [maxBackoff, setMaxBackoff] = useState('600')
  const [labels, setLabels] = useState<KeyValueRow[]>([])
  const filterCheck = useFilterCheck(project, filter, topic)

  const seconds = durationSeconds(amount, unit)
  const problems = {
    id: idProblem(id),
    endpoint: push ? endpointProblem(endpoint) : undefined,
    ack: ackDeadlineProblem(ack),
    filter:
      filter.trim() && filterCheck.check && !filterCheck.check.ok ? 'fix the filter' : undefined,
    retention: retentionProblem(seconds),
    ttl: expires && !(Number(ttlDays) >= 1) ? 'Enter whole days.' : undefined,
    deadLetter: deadLetter
      ? deadTopic === ''
        ? 'Choose the topic to dead-letter into.'
        : maxDeliveriesProblem(maxDeliveries)
      : undefined,
    retry: backoff ? backoffProblem(minBackoff, maxBackoff) : undefined,
  }
  const valid = Object.values(problems).every((problem) => problem === undefined)
  const suggestedDead = `${topicId}-dead`
  const deadExists = topics.includes(fullName(project, 'topics', suggestedDead))

  const createDead = useMutation({
    mutationFn: () => createTopic({ name: fullName(project, 'topics', suggestedDead) }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topics(project) })
      setDeadTopic(created.name)
    },
  })

  const create = useMutation({
    mutationFn: () => {
      const body: PubsubCreateSubscriptionBody = {
        name: fullName(project, 'subscriptions', id),
        topic,
        ackDeadlineSeconds: Number(ack),
        ordering,
        exactlyOnce,
        retainAcked,
        retentionSeconds: seconds ?? null,
        labels: Object.fromEntries(
          labels.filter((row) => row.enabled && row.key !== '').map((row) => [row.key, row.value]),
        ),
      }
      if (push) body.pushEndpoint = endpoint
      if (filter.trim()) body.filter = filter.trim()
      if (expires) body.expirationTtlSeconds = Math.round(Number(ttlDays) * 86_400)
      if (deadLetter)
        body.deadLetter = { topic: deadTopic, maxDeliveryAttempts: Number(maxDeliveries) }
      if (backoff)
        body.retry = {
          minimumBackoffSeconds: Number(minBackoff),
          maximumBackoffSeconds: Number(maxBackoff),
        }
      return createSubscription(body)
    },
    onSuccess: (subscription) => {
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topics(project) })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topic(project, topic) })
      onClose()
      onCreated(subscription.name)
    },
  })

  return (
    <form
      className="flex max-h-[calc(100vh-6rem)] flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (valid) create.mutate()
      }}
      data-testid="create-subscription"
    >
      <div className="flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">
          New subscription on <span className="font-mono text-[0.9em]">{topicId}</span>
        </Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <div className="grid min-h-0 gap-4 overflow-auto">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <div className="grid content-start gap-4">
            <Field label="Subscription id">
              <Input
                size="sm"
                value={id}
                onChange={(event) => {
                  setId(event.target.value)
                  setTouched(true)
                }}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                placeholder={`${topicId}-worker`}
                variant={touched && problems.id ? 'error' : 'default'}
                className="w-full font-mono"
                data-testid="create-subscription-id"
              />
              {touched && problems.id ? (
                <Problem testId="create-subscription-id-error">{problems.id}</Problem>
              ) : (
                <span className="truncate font-mono text-[12px] text-kumo-subtle">
                  {fullName(project, 'subscriptions', id || '…')}
                </span>
              )}
            </Field>
            <Field label="Ack deadline">
              <span className="flex items-center gap-1.5">
                <Input
                  size="sm"
                  type="number"
                  value={ack}
                  onChange={(event) => setAck(event.target.value)}
                  aria-label="Ack deadline in seconds"
                  className="w-20 font-mono"
                  data-testid="create-subscription-ack"
                />
                <span className="text-[12px] text-kumo-subtle">seconds (10–600)</span>
              </span>
              {problems.ack && <Problem>{problems.ack}</Problem>}
            </Field>
            <div className="grid gap-2">
              <Checkbox
                checked={ordering}
                onCheckedChange={(checked) => setOrdering(Boolean(checked))}
                label="Order by ordering key"
              />
              <Checkbox
                checked={exactlyOnce}
                onCheckedChange={(checked) => setExactlyOnce(Boolean(checked))}
                label="Exactly-once delivery"
              />
              <Checkbox
                checked={retainAcked}
                onCheckedChange={(checked) => setRetainAcked(Boolean(checked))}
                label="Keep acknowledged messages (for replay)"
              />
            </div>
            <Field label="Expiration">
              <Radio.Group
                value={expires ? 'after' : 'never'}
                onValueChange={(value) => setExpires(value === 'after')}
                orientation="horizontal"
              >
                <Radio.Legend className="sr-only">Expiration</Radio.Legend>
                <Radio.Item label="Never" value="never" />
                <Radio.Item label="After days of no activity" value="after" />
              </Radio.Group>
              {expires && (
                <span className="flex items-center gap-1.5">
                  <Input
                    size="sm"
                    type="number"
                    value={ttlDays}
                    onChange={(event) => setTtlDays(event.target.value)}
                    aria-label="Days of no activity"
                    className="w-20 font-mono"
                  />
                  <span className="text-[12px] text-kumo-subtle">days — stored, not enforced</span>
                </span>
              )}
              {problems.ttl && <Problem>{problems.ttl}</Problem>}
            </Field>
          </div>
          <div className="grid content-start gap-4">
            <Field label="Delivery">
              <Radio.Group
                value={push ? 'push' : 'pull'}
                onValueChange={(value) => setPush(value === 'push')}
                orientation="horizontal"
              >
                <Radio.Legend className="sr-only">Delivery</Radio.Legend>
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
                  data-testid="create-subscription-endpoint"
                />
              )}
              {push && endpoint !== '' && problems.endpoint && (
                <Problem>{problems.endpoint}</Problem>
              )}
            </Field>
            <Field label="Filter">
              <AttributesFilterField
                value={filter}
                onChange={setFilter}
                project={project}
                topic={topic}
                testId="create-subscription-filter"
              />
              <FilterCheckLine project={project} value={filter} topic={topic} />
              {!filter.trim() && (
                <span className="text-[12px] text-kumo-subtle">
                  Empty: every message. The emulator cannot change a filter later.
                </span>
              )}
            </Field>
            <Field label="Retention">
              <RetentionField
                amount={amount}
                unit={unit}
                onChange={(nextAmount, nextUnit) => {
                  setAmount(nextAmount)
                  setUnit(nextUnit)
                }}
                label="Keep unacknowledged messages for"
              />
              {problems.retention && <Problem>{problems.retention}</Problem>}
            </Field>
          </div>
        </div>
        <div className="grid gap-1 border-t border-kumo-line pt-2">
          <Fold
            title="Dead letter"
            summary={
              deadLetter && deadTopic ? `${shortName(deadTopic)} after ${maxDeliveries}` : 'off'
            }
            testId="create-subscription-dead-letter"
          >
            <Checkbox
              checked={deadLetter}
              onCheckedChange={(checked) => setDeadLetter(Boolean(checked))}
              label="Move a message to another topic after too many deliveries"
              data-testid="create-subscription-dead-letter-on"
            />
            {deadLetter && (
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  size="xs"
                  value={deadTopic}
                  onValueChange={(next) => setDeadTopic(String(next))}
                  placeholder="Choose a topic"
                  aria-label="Dead-letter topic"
                  className="h-6.5 w-56 min-w-0"
                >
                  {topics
                    .filter((candidate) => candidate !== topic)
                    .map((candidate) => (
                      <Select.Option key={candidate} value={candidate}>
                        <span className="font-mono text-[12px]">{shortName(candidate)}</span>
                      </Select.Option>
                    ))}
                </Select>
                {!deadExists && (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    loading={createDead.isPending}
                    onClick={() => createDead.mutate()}
                    data-testid="create-subscription-create-dead"
                  >
                    Create <span className="font-mono text-[0.9em]">{suggestedDead}</span>
                  </Button>
                )}
                <span className="flex items-center gap-1.5 text-[12px] text-kumo-subtle">
                  Max deliveries
                  <Input
                    size="sm"
                    type="number"
                    value={maxDeliveries}
                    onChange={(event) => setMaxDeliveries(event.target.value)}
                    aria-label="Max deliveries"
                    className="w-16 font-mono"
                  />
                  (5–100)
                </span>
              </div>
            )}
            {problems.deadLetter && <Problem>{problems.deadLetter}</Problem>}
            {createDead.isError && <Problem>{errorText(createDead.error)}</Problem>}
          </Fold>
          <Fold
            title="Retry policy"
            summary={backoff ? `backoff ${minBackoff}–${maxBackoff} s` : 'immediately'}
          >
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
                  className="w-16 font-mono"
                />
                s · max
                <Input
                  size="sm"
                  type="number"
                  value={maxBackoff}
                  onChange={(event) => setMaxBackoff(event.target.value)}
                  aria-label="Maximum backoff in seconds"
                  className="w-16 font-mono"
                />
                s
              </span>
            )}
            {problems.retry && <Problem>{problems.retry}</Problem>}
            <span className="text-[12px] text-kumo-subtle">
              Stored. A nacked message is redelivered at once, as the official emulator does.
            </span>
          </Fold>
          <Fold
            title="Labels"
            summary={
              labels.filter((row) => row.key).length === 0
                ? 'none'
                : `${labels.filter((row) => row.key).length}`
            }
          >
            <KeyValueEditor label="Labels" rows={labels} onChange={setLabels} />
          </Fold>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          {create.isError && (
            <span className="text-[13px] text-kumo-danger" data-testid="create-subscription-error">
              {errorText(create.error)}
            </span>
          )}
        </span>
        <Button variant="secondary" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={valid ? 'primary' : 'secondary'}
          type="submit"
          loading={create.isPending}
          data-testid="create-subscription-submit"
        >
          Create
        </Button>
      </div>
    </form>
  )
}
