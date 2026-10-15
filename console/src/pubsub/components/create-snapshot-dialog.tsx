// New snapshot: what one subscription has not acknowledged, recorded now so
// it can be replayed to later (S6). The id is checked with the engine's
// rule as it is typed; the subscription is the one in view, or one of the
// topic's (the functions' own subscriptions are drained, so never offered).

import { Button, Dialog, Input, Select, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errorText } from '@/lib/error-text'
import { pad } from '@/lib/format'
import { toast } from '@/lib/toasts'
import { createSnapshot } from '../api'
import { fullName, idProblem, shortName } from '../names'
import { pubsubKeys } from '../queries'
import { useGeneration } from './create-topic-dialog'

/** A snapshot id nobody has used yet today: `orders-worker-1002`. */
export function suggestedSnapshotId(subscription: string, at: Date = new Date()): string {
  return `${shortName(subscription)}-${pad(at.getHours())}${pad(at.getMinutes())}`
}

export function CreateSnapshotDialog({
  open,
  project,
  subscriptions,
  initialSubscription,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  project: string
  /** The subscriptions a snapshot can be taken of (full names). */
  subscriptions: readonly string[]
  initialSubscription?: string | undefined
  onOpenChange: (open: boolean) => void
  onCreated?: ((snapshot: string) => void) | undefined
}) {
  const generation = useGeneration(open)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="p-6">
        <CreateSnapshotForm
          key={generation}
          project={project}
          subscriptions={subscriptions}
          initialSubscription={initialSubscription ?? subscriptions[0] ?? ''}
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function CreateSnapshotForm({
  project,
  subscriptions,
  initialSubscription,
  onClose,
  onCreated,
}: {
  project: string
  subscriptions: readonly string[]
  initialSubscription: string
  onClose: () => void
  onCreated?: ((snapshot: string) => void) | undefined
}) {
  const queryClient = useQueryClient()
  const [subscription, setSubscription] = useState(initialSubscription)
  const [id, setId] = useState(() =>
    initialSubscription ? suggestedSnapshotId(initialSubscription) : '',
  )
  const [touched, setTouched] = useState(false)
  // Opened from a link, the topic's subscriptions arrive after the form: the first is taken then.
  const first = subscriptions[0]
  if (subscription === '' && first !== undefined) {
    setSubscription(first)
    if (!touched) setId(suggestedSnapshotId(first))
  }
  const problem = idProblem(id)
  const valid = !problem && subscription !== ''

  const create = useMutation({
    mutationFn: () => createSnapshot({ name: fullName(project, 'snapshots', id), subscription }),
    onSuccess: (snapshot) => {
      void queryClient.invalidateQueries({ queryKey: pubsubKeys.snapshots(project) })
      toast({
        key: `pubsub-snapshot-${snapshot.name}`,
        title: `Recorded ${snapshot.id}`,
        description: `${snapshot.unacked} ${snapshot.unacked === 1 ? 'message' : 'messages'} of ${shortName(subscription)} waiting.`,
        tone: 'success',
      })
      onClose()
      onCreated?.(snapshot.name)
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
      data-testid="create-snapshot"
    >
      <div className="flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">New snapshot</Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
        />
      </div>
      <Dialog.Description className="-mt-2 text-kumo-subtle">
        A snapshot records which messages a subscription has not acknowledged, so you can replay it
        to that point later.
      </Dialog.Description>
      <label className="grid gap-1">
        <Text variant="secondary" size="sm" as="span">
          Of subscription
        </Text>
        <Select
          size="sm"
          value={subscription}
          onValueChange={(next) => setSubscription(String(next))}
          aria-label="Subscription"
          renderValue={() => <span className="font-mono">{shortName(subscription) || 'none'}</span>}
          className="w-full"
          data-testid="create-snapshot-subscription"
        >
          {subscriptions.map((name) => (
            <Select.Option key={name} value={name}>
              <span className="font-mono text-[12px]">{shortName(name)}</span>
            </Select.Option>
          ))}
        </Select>
      </label>
      <label className="grid gap-1">
        <Text variant="secondary" size="sm" as="span">
          Snapshot id
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
          variant={touched && problem ? 'error' : 'default'}
          className="w-full font-mono"
          aria-invalid={touched && problem ? true : undefined}
          data-testid="create-snapshot-id"
        />
        {touched && problem ? (
          <span className="text-[12px] text-kumo-danger">{problem}</span>
        ) : (
          <span className="truncate font-mono text-[12px] text-kumo-subtle">
            {fullName(project, 'snapshots', id || '…')}
          </span>
        )}
      </label>
      {create.isError && (
        <p className="m-0 text-[13px] text-kumo-danger" data-testid="create-snapshot-error">
          {errorText(create.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={!valid}
          loading={create.isPending}
          data-testid="create-snapshot-submit"
        >
          Create snapshot
        </Button>
      </div>
    </form>
  )
}
