// New topic (S13): the id checked as it is typed with the engine's own rule
// and its full name previewed under it, a default subscription offered (most
// topics need one to be read), and what the Cloud console asks for besides —
// retention, a schema, labels — folded away until wanted. What the engine
// answers (`Topic already exists`) is said in the footer with its fix.

import { Button, Checkbox, Collapsible, Dialog, Input, Radio, Select, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { errorText } from '@/lib/error-text'
import { type KeyValueRow, KeyValueEditor } from '@/components/console/key-value-editor'
import { createTopic } from '../api'
import { fullName, idProblem } from '../names'
import { pubsubKeys, schemasQuery } from '../queries'
import {
  type DurationUnit,
  RetentionField,
  durationSeconds,
  retentionProblem,
} from './retention-field'

/** A folded part of a create form: its name, and what it holds while shut. */
export function Fold({
  title,
  summary,
  children,
  testId,
}: {
  title: string
  summary: string
  children: ReactNode
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} data-testid={testId}>
      <Collapsible.DefaultTrigger>
        <span className="flex items-center gap-2 text-[13px]">
          <span className="text-kumo-default">{title}</span>
          {!open && <span className="text-kumo-subtle">{summary}</span>}
        </span>
      </Collapsible.DefaultTrigger>
      <Collapsible.DefaultPanel>
        <div className="grid gap-2 pt-2 pb-1">{children}</div>
      </Collapsible.DefaultPanel>
    </Collapsible.Root>
  )
}

/** A number that moves each time `open` turns true: the key that gives a dialog a fresh form. */
export function useGeneration(open: boolean): number {
  const [state, setState] = useState({ open, generation: 0 })
  if (state.open !== open) {
    setState({ open, generation: open ? state.generation + 1 : state.generation })
    return open ? state.generation + 1 : state.generation
  }
  return state.generation
}

export function CreateTopicDialog({
  open,
  project,
  initialId,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  project: string
  /** A refused publish's id, or what was typed into the path field. */
  initialId?: string | undefined
  onOpenChange: (open: boolean) => void
  onCreated: (topic: string) => void
}) {
  const generation = useGeneration(open)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="p-6">
        {/* A fresh form on each open, so it starts from what the link says;
            kept while it closes, so its contents do not vanish mid-animation. */}
        <CreateTopicForm
          key={generation}
          project={project}
          initialId={initialId ?? ''}
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function CreateTopicForm({
  project,
  initialId,
  onClose,
  onCreated,
}: {
  project: string
  initialId: string
  onClose: () => void
  onCreated: (topic: string) => void
}) {
  const queryClient = useQueryClient()
  const [id, setId] = useState(initialId)
  const [touched, setTouched] = useState(initialId !== '')
  const [withSubscription, setWithSubscription] = useState(true)
  const [keep, setKeep] = useState(false)
  const [amount, setAmount] = useState('7')
  const [unit, setUnit] = useState<DurationUnit>('days')
  const [schema, setSchema] = useState('')
  const [encoding, setEncoding] = useState('JSON')
  const [labels, setLabels] = useState<KeyValueRow[]>([])
  const schemas = useQuery(schemasQuery(project))

  const problem = idProblem(id)
  const seconds = durationSeconds(amount, unit)
  const retentionError = keep ? retentionProblem(seconds) : undefined
  const subscriptionId = `${id}-sub`
  const subscriptionProblem = withSubscription && !problem ? idProblem(subscriptionId) : undefined
  const valid = !problem && !retentionError && !subscriptionProblem

  const create = useMutation({
    mutationFn: () =>
      createTopic({
        name: fullName(project, 'topics', id),
        ...(keep && seconds !== undefined ? { retentionSeconds: seconds } : {}),
        ...(schema ? { schema: { schema, encoding } } : {}),
        labels: Object.fromEntries(
          labels.filter((row) => row.enabled && row.key !== '').map((row) => [row.key, row.value]),
        ),
        defaultSubscription: withSubscription,
      }),
    onSuccess: (topic) => {
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.topics(project) })
      onClose()
      onCreated(topic.name)
    },
  })

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (valid) create.mutate()
      }}
      data-testid="create-topic"
    >
      <div className="flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">New topic</Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <Dialog.Description className="-mt-2 text-kumo-subtle">
        Publishers send to a topic; each subscription on it keeps its own copy of every message.
      </Dialog.Description>
      <label className="grid gap-1">
        <Text variant="secondary" size="sm" as="span">
          Topic id
        </Text>
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
          placeholder="orders"
          variant={touched && problem ? 'error' : 'default'}
          className="w-full font-mono"
          aria-invalid={touched && problem ? true : undefined}
          data-testid="create-topic-id"
        />
        {touched && problem ? (
          <span className="text-[12px] text-kumo-danger" data-testid="create-topic-id-error">
            {problem}
          </span>
        ) : (
          <span
            className="truncate font-mono text-[12px] text-kumo-subtle"
            data-testid="create-topic-name"
          >
            {fullName(project, 'topics', id || '…')}
          </span>
        )}
      </label>
      <div className="grid gap-1">
        <Checkbox
          checked={withSubscription}
          onCheckedChange={(checked) => setWithSubscription(Boolean(checked))}
          label={
            <span>
              Also create a subscription{' '}
              <span className="font-mono text-[0.9em]">{id ? subscriptionId : '<id>-sub'}</span>
            </span>
          }
          data-testid="create-topic-default-subscription"
        />
        {subscriptionProblem && (
          <span className="text-[12px] text-kumo-danger">{subscriptionProblem}</span>
        )}
      </div>
      <div className="grid gap-1 border-t border-kumo-line pt-2">
        <Fold
          title="Retention"
          summary={keep && seconds ? `keep for ${amount} ${unit}` : 'off'}
          testId="create-topic-retention"
        >
          <Radio.Group
            value={keep ? 'keep' : 'off'}
            onValueChange={(value) => setKeep(value === 'keep')}
            orientation="horizontal"
          >
            <Radio.Legend className="sr-only">Retention</Radio.Legend>
            <Radio.Item label="Off" value="off" />
            <Radio.Item label="Keep messages for new subscriptions" value="keep" />
          </Radio.Group>
          {keep && (
            <RetentionField
              amount={amount}
              unit={unit}
              onChange={(nextAmount, nextUnit) => {
                setAmount(nextAmount)
                setUnit(nextUnit)
              }}
              label="Keep messages for"
            />
          )}
          {retentionError && <span className="text-[12px] text-kumo-danger">{retentionError}</span>}
        </Fold>
        <Fold
          title="Schema"
          summary={schema ? `${schema.split('/').at(-1)} · ${encoding}` : 'none'}
        >
          <Select
            size="xs"
            value={schema}
            onValueChange={(next) => setSchema(String(next))}
            aria-label="Schema"
            className="h-6.5 w-full min-w-0"
            renderValue={() => (
              <span className="font-mono">{schema ? schema.split('/').at(-1) : 'none'}</span>
            )}
          >
            <Select.Option value="">
              <span className="text-[12px]">none</span>
            </Select.Option>
            {(schemas.data?.items ?? []).map((item) => (
              <Select.Option key={item.name} value={item.name}>
                <span className="font-mono text-[12px]">{item.id}</span>
              </Select.Option>
            ))}
          </Select>
          {schema && (
            <Radio.Group
              value={encoding}
              onValueChange={(value) => setEncoding(String(value))}
              orientation="horizontal"
            >
              <Radio.Legend className="sr-only">Encoding</Radio.Legend>
              <Radio.Item label="JSON" value="JSON" />
              <Radio.Item label="Binary" value="BINARY" />
            </Radio.Group>
          )}
          {schemas.data?.items.length === 0 && (
            <span className="text-[12px] text-kumo-subtle">This project has no schemas yet.</span>
          )}
        </Fold>
        <Fold
          title="Labels"
          summary={
            labels.filter((row) => row.key).length === 0
              ? 'none'
              : `${labels.filter((row) => row.key).length}`
          }
        >
          <KeyValueEditor
            label="Labels"
            rows={labels}
            onChange={setLabels}
            testId="create-topic-labels"
          />
        </Fold>
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          {create.isError && (
            <span className="text-[13px] text-kumo-danger" data-testid="create-topic-error">
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
          data-testid="create-topic-submit"
        >
          Create
        </Button>
      </div>
    </form>
  )
}
