// A topic's settings (S7), a long-lived view of the resource as in the Cloud
// console rather than a dialog: what it is, how long it keeps messages for
// subscriptions created later, the schema it checks messages against, what
// the console's history holds of it, and deleting it — saying what happens
// to its subscriptions and offering to delete them too.

import { Button, Select, Switch, Tooltip } from '@cloudflare/kumo'
import { TrashIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { errorText } from '@/lib/error-text'
import type { PubsubTopicDetail } from '@/api/generated/messaging/PubsubTopicDetail'
import { CopyField } from '@/components/console/copy-button'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { EntityLink } from '@/components/console/entity-link'
import { RelativeTime } from '@/components/console/relative-time'
import { formatBytes, formatNumber, utcStamp } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { deleteTopic, updateTopic } from '../api'
import { shortName } from '../names'
import { pubsubKeys, schemaQuery, schemasQuery } from '../queries'
import {
  type DurationUnit,
  RetentionField,
  durationSeconds,
  retentionProblem,
  splitDuration,
} from './retention-field'

/** A settings section: a 16 px heading, then its rows. */
export function SettingsSection({
  title,
  children,
  testId,
}: {
  title: string
  children: ReactNode
  testId?: string
}) {
  return (
    <section
      className="grid gap-3 border-b border-kumo-line py-5 first:pt-0 last:border-b-0"
      data-testid={testId}
    >
      <h2 className="m-0 text-[16px] font-semibold text-kumo-default">{title}</h2>
      {children}
    </section>
  )
}

/** One fact or control of a settings section: a 13 px name beside its value. */
export function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] items-start gap-4">
      <span className="pt-1 text-[13px] text-kumo-subtle">{label}</span>
      <div className="grid min-w-0 gap-1.5">{children}</div>
    </div>
  )
}

/** A sentence under a control: 12 px, quiet unless it says something is wrong. */
export function Note({ children, tone }: { children: ReactNode; tone?: 'danger' | 'warning' }) {
  return (
    <p
      className={`m-0 text-[12px] ${tone === 'danger' ? 'text-kumo-danger' : tone === 'warning' ? 'text-kumo-warning' : 'text-kumo-subtle'}`}
    >
      {children}
    </p>
  )
}

export function TopicSettings({
  project,
  detail,
  onDeleted,
}: {
  project: string
  detail: PubsubTopicDetail
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const name = detail.summary.name
  const topicId = detail.summary.id
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: pubsubKeys.topic(project, name) })
    void queryClient.invalidateQueries({ queryKey: pubsubKeys.topics(project) })
  }

  // Retention.
  const initial =
    detail.retentionSeconds !== null
      ? splitDuration(detail.retentionSeconds)
      : { amount: '7', unit: 'days' as DurationUnit }
  const [keep, setKeep] = useState(detail.retentionSeconds !== null)
  const [amount, setAmount] = useState(initial.amount)
  const [unit, setUnit] = useState<DurationUnit>(initial.unit)
  const seconds = durationSeconds(amount, unit)
  const retentionError = keep ? retentionProblem(seconds) : undefined
  const retentionChanged =
    keep !== (detail.retentionSeconds !== null) || (keep && seconds !== detail.retentionSeconds)
  const saveRetention = useMutation({
    mutationFn: () =>
      updateTopic({ name, mask: ['retention'], retentionSeconds: keep ? (seconds ?? null) : null }),
    onSuccess: () => {
      refresh()
      toast({
        key: `pubsub-topic-${name}`,
        title: `Saved the retention of ${topicId}`,
        tone: 'success',
      })
    },
  })

  // Deleting.
  const [deleting, setDeleting] = useState(false)
  const [withSubscriptions, setWithSubscriptions] = useState(false)
  const own = detail.subscriptions.filter(
    (subscription) => subscription.summary.managed !== 'functions',
  )
  const remove = useMutation({
    mutationFn: () => deleteTopic({ name, subscriptions: withSubscriptions ? 'delete' : 'keep' }),
    onSuccess: () => {
      setDeleting(false)
      toast({ key: `pubsub-topic-${name}`, title: `Deleted ${topicId}`, tone: 'success' })
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topics(project) })
      onDeleted()
    },
  })

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="pubsub-topic-settings">
      <div className="max-w-[640px] px-6 py-5">
        <SettingsSection title="Topic">
          <SettingsRow label="Full name">
            <CopyField value={name} className="text-[12px]" testId="topic-full-name" />
          </SettingsRow>
          <SettingsRow label="Created">
            <span className="text-[12px] text-kumo-default">
              <span className="font-mono">{utcStamp(detail.createdAt)}</span> ·{' '}
              <RelativeTime iso={detail.createdAt} />
            </span>
          </SettingsRow>
          <SettingsRow label="Labels">
            {Object.keys(detail.labels).length === 0 ? (
              <span className="text-[12px] text-kumo-inactive">none</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {Object.entries(detail.labels).map(([key, value]) => (
                  <span key={key} className="rounded bg-kumo-tint px-1 font-mono text-[11px]">
                    {key}={value}
                  </span>
                ))}
              </span>
            )}
            <Note>Labels are set when a topic is created; the emulator does not update them.</Note>
          </SettingsRow>
          {detail.kmsKeyName && (
            <SettingsRow label="KMS key">
              <span className="font-mono text-[12px] [overflow-wrap:anywhere]">
                {detail.kmsKeyName}
              </span>
              <Note>Stored, not used: the emulator does not encrypt messages.</Note>
            </SettingsRow>
          )}
        </SettingsSection>

        <SettingsSection title="Message retention" testId="topic-retention">
          <Switch
            variant="neutral"
            checked={keep}
            onCheckedChange={setKeep}
            label="Keep messages for new subscriptions"
            data-testid="topic-retention-switch"
          />
          <div className="flex items-center gap-2">
            <RetentionField
              amount={amount}
              unit={unit}
              disabled={!keep}
              onChange={(nextAmount, nextUnit) => {
                setAmount(nextAmount)
                setUnit(nextUnit)
              }}
              label="Keep messages for"
              testId="topic-retention-duration"
            />
          </div>
          <Note>
            A subscription created later receives the messages published within this window, as in
            production.
          </Note>
          {keep && detail.retentionSeconds === null && (
            <Note>
              Messages published before now and already dropped from the console's history are not
              brought back.
            </Note>
          )}
          {retentionError && <Note tone="danger">{retentionError}</Note>}
          {saveRetention.isError && <Note tone="danger">{errorText(saveRetention.error)}</Note>}
          <div>
            <Button
              variant={retentionChanged && !retentionError ? 'primary' : 'secondary'}
              disabled={!retentionChanged || retentionError !== undefined}
              loading={saveRetention.isPending}
              onClick={() => saveRetention.mutate()}
              data-testid="topic-retention-save"
            >
              Save
            </Button>
          </div>
        </SettingsSection>

        <SchemaSettings project={project} detail={detail} onSaved={refresh} />

        <SettingsSection title="History in the console" testId="topic-history">
          <span className="font-mono text-[12px] text-kumo-default tabular-nums">
            {formatNumber(detail.history.messages)} messages · {formatBytes(detail.history.bytes)}{' '}
            kept
            {detail.history.dropped > 0
              ? ` · ${formatNumber(detail.history.dropped)} dropped since start`
              : ''}
          </span>
          <Note>
            The console keeps the newest {formatNumber(detail.history.capacityMessages)} messages (
            {formatBytes(detail.history.capacityBytes)}) of each topic so you can read them; this is
            not message retention, and subscriptions keep their own backlog whatever it holds.
          </Note>
        </SettingsSection>

        <SettingsSection title="Danger" testId="topic-danger">
          <div>
            <Button
              variant="ghost"
              icon={<TrashIcon className="text-kumo-danger" />}
              onClick={() => {
                setWithSubscriptions(false)
                remove.reset()
                setDeleting(true)
              }}
              data-testid="topic-delete"
            >
              <span className="text-kumo-danger">Delete topic…</span>
            </Button>
          </div>
        </SettingsSection>
      </div>
      <DangerConfirm
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${topicId}`}
        description={
          <>
            Publishing to <span className="font-mono text-[0.9em]">{topicId}</span> fails from now
            on until it is created again.
          </>
        }
        consequences={[
          own.length === 0
            ? 'It has no subscriptions of its own.'
            : withSubscriptions
              ? `Its ${own.length === 1 ? 'subscription' : `${own.length} subscriptions`} (${own.map((subscription) => subscription.summary.id).join(', ')}) ${own.length === 1 ? 'is' : 'are'} deleted with it, backlog and all.`
              : `Its ${own.length === 1 ? 'subscription keeps' : `${own.length} subscriptions keep`} their backlog and show _deleted-topic_ (${own.map((subscription) => subscription.summary.id).join(', ')}).`,
          'Its history in the console goes with it. The emulator keeps nothing after a restart either way.',
        ]}
        {...(own.length > 0
          ? {
              option: {
                label: `Also delete its ${own.length === 1 ? 'subscription' : `${own.length} subscriptions`}`,
                checked: withSubscriptions,
                onChange: setWithSubscriptions,
              },
            }
          : {})}
        {...(remove.isError ? { error: errorText(remove.error) } : {})}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
        testId="topic-delete-confirm"
      />
    </div>
  )
}

/** The topic's schema binding, and changing it (the engine cannot remove one). */
function SchemaSettings({
  project,
  detail,
  onSaved,
}: {
  project: string
  detail: PubsubTopicDetail
  onSaved: () => void
}) {
  const binding = detail.schema
  const [changing, setChanging] = useState(false)
  const [schema, setSchema] = useState(binding?.deleted === false ? binding.schema : '')
  const [encoding, setEncoding] = useState(binding?.encoding ?? 'JSON')
  const [first, setFirst] = useState(binding?.firstRevisionId ?? '')
  const [last, setLast] = useState(binding?.lastRevisionId ?? '')
  const schemas = useQuery({ ...schemasQuery(project), enabled: changing && project !== '' })
  const revisions = useQuery({
    ...schemaQuery(project, schema),
    enabled: changing && schema !== '',
  })
  const save = useMutation({
    mutationFn: () =>
      updateTopic({
        name: detail.summary.name,
        mask: ['schema'],
        schema: {
          schema,
          encoding,
          ...(first ? { firstRevisionId: first } : {}),
          ...(last ? { lastRevisionId: last } : {}),
        },
      }),
    onSuccess: () => {
      setChanging(false)
      onSaved()
      toast({
        key: `pubsub-topic-${detail.summary.name}`,
        title: `Saved the schema of ${detail.summary.id}`,
        tone: 'success',
      })
    },
  })
  const removeTip =
    'The emulator cannot remove a topic’s schema (it answers No schema name provided). Delete and re-create the topic.'
  return (
    <SettingsSection title="Schema" testId="topic-schema">
      {binding ? (
        <>
          <SettingsRow label="Schema">
            {binding.deleted ? (
              <span className="font-mono text-[12px] text-kumo-danger">_deleted-schema_</span>
            ) : (
              <EntityLink
                entity={{
                  kind: 'pubsub.schema',
                  key: binding.schema,
                  label: shortName(binding.schema),
                }}
              />
            )}
            {binding.deleted && (
              <Note tone="danger">
                The schema was deleted, so every publish to this topic is refused (Schema associated
                with topic deleted).
              </Note>
            )}
          </SettingsRow>
          <SettingsRow label="Encoding">
            <span className="font-mono text-[12px]">{binding.encoding}</span>
          </SettingsRow>
          <SettingsRow label="Revisions">
            <span className="font-mono text-[12px]">
              {binding.firstRevisionId ?? 'first'} … {binding.lastRevisionId ?? 'latest'} · checked
              against {binding.boundRevisionId}
            </span>
          </SettingsRow>
        </>
      ) : (
        <Note>No schema: the topic takes any message.</Note>
      )}
      {changing ? (
        <div className="grid gap-3 rounded-lg p-3 ring ring-kumo-line">
          <SettingsRow label="Schema">
            <Select
              size="xs"
              value={schema}
              onValueChange={(next) => {
                setSchema(String(next))
                setFirst('')
                setLast('')
              }}
              placeholder="Choose a schema"
              aria-label="Schema"
              className="h-6.5 w-full min-w-0"
            >
              {(schemas.data?.items ?? []).map((item) => (
                <Select.Option key={item.name} value={item.name}>
                  <span className="font-mono text-[12px]">{item.id}</span>
                </Select.Option>
              ))}
            </Select>
            {schemas.data?.items.length === 0 && <Note>This project has no schemas yet.</Note>}
          </SettingsRow>
          <SettingsRow label="Encoding">
            <Select
              size="xs"
              value={encoding}
              onValueChange={(next) => setEncoding(String(next))}
              aria-label="Encoding"
              className="h-6.5 w-32"
            >
              <Select.Option value="JSON">JSON</Select.Option>
              <Select.Option value="BINARY">BINARY</Select.Option>
            </Select>
          </SettingsRow>
          <SettingsRow label="Revisions">
            <span className="flex items-center gap-2">
              <RevisionSelect
                label="First revision"
                value={first}
                onChange={setFirst}
                revisions={revisions.data?.revisions ?? []}
                empty="first"
              />
              <span className="text-[12px] text-kumo-subtle">to</span>
              <RevisionSelect
                label="Last revision"
                value={last}
                onChange={setLast}
                revisions={revisions.data?.revisions ?? []}
                empty="latest"
              />
            </span>
          </SettingsRow>
          {save.isError && <Note tone="danger">{errorText(save.error)}</Note>}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setChanging(false)}>
              Cancel
            </Button>
            <Button
              variant={schema ? 'primary' : 'secondary'}
              disabled={!schema}
              loading={save.isPending}
              onClick={() => save.mutate()}
              data-testid="topic-schema-save"
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => setChanging(true)}
            data-testid="topic-schema-change"
          >
            {binding ? 'Change…' : 'Add a schema…'}
          </Button>
          {binding && (
            <Tooltip
              content={removeTip}
              render={
                <span className="inline-flex">
                  <Button variant="ghost" disabled>
                    Remove schema
                  </Button>
                </span>
              }
            />
          )}
        </div>
      )}
      {!binding && (
        <Note>
          Once a topic has a schema the emulator refuses any message that does not match it, as
          production does.
        </Note>
      )}
    </SettingsSection>
  )
}

function RevisionSelect({
  label,
  value,
  onChange,
  revisions,
  empty,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  revisions: readonly { id: string; createdAt: string }[]
  empty: string
}) {
  return (
    <Select
      size="xs"
      value={value}
      onValueChange={(next) => onChange(String(next))}
      aria-label={label}
      className="h-6.5 w-36"
      renderValue={() => <span className="font-mono">{value || empty}</span>}
    >
      <Select.Option value="">
        <span className="font-mono text-[12px]">{empty}</span>
      </Select.Option>
      {revisions.map((revision) => (
        <Select.Option key={revision.id} value={revision.id}>
          <span className="font-mono text-[12px]">{revision.id}</span>
        </Select.Option>
      ))}
    </Select>
  )
}
