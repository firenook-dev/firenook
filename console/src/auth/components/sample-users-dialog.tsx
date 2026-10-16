// Add sample users (`?new=sample`): 10, 100 or 1,000 realistic accounts —
// email, phone and Google, some disabled, unverified, with MFA and with
// claims — marked as samples (`sample.test`, uids that start `sample-`),
// made in the page and imported through the engine's import (one upload,
// one job). No trigger fires; `is:sample` finds them; Delete sample users
// removes exactly them.

import { Button, Dialog, Select, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { jobProgress } from '@/components/console/danger-confirm'
import { formatCount, formatNumber } from '@/lib/format'
import { cancelJob, useJob } from '@/lib/jobs'
import { startImport, uploadImport } from '../api'
import {
  SAMPLE_COUNTS,
  SAMPLE_PASSWORD,
  randomSeed,
  sampleFile,
  sampleUsers,
} from '../sample-users'
import { refusal } from '../user-actions'
import { DialogField } from './dialog-field'

const USERS = { one: 'user', other: 'users' }

export function SampleUsersDialog({
  open,
  onOpenChange,
  project,
  tenant,
  blocked,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: string
  tenant: string | undefined
  blocked: string | undefined
  /** The users were imported: show them (`is:sample`). */
  onDone: () => void
}) {
  const [count, setCount] = useState<number>(100)
  const [jobId, setJobId] = useState<string | undefined>(undefined)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setJobId(undefined)
  }
  const make = useMutation({
    mutationFn: async () => {
      const users = sampleUsers({ count, seed: randomSeed() })
      const preview = await uploadImport(project, tenant, sampleFile(users))
      return startImport({ importId: preview.importId, mode: 'skip' })
    },
    onSuccess: (job) => setJobId(job.id),
  })
  const job = useJob(jobId)
  const running = make.isPending || job?.state === 'running'
  const finished = job !== undefined && job.state !== 'running'
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && running) return
        if (!next) make.reset()
        onOpenChange(next)
      }}
    >
      <Dialog size="base" className="p-6">
        <div className="flex max-h-[calc(100vh-6rem)] flex-col" data-testid="sample-users-dialog">
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold">Add sample users</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              disabled={running}
              render={
                <Button
                  variant="ghost"
                  shape="square"
                  icon={<XIcon />}
                  aria-label="Close"
                  disabled={running}
                />
              }
            />
          </div>
          <Dialog.Description className="text-kumo-subtle">
            Email, phone and Google accounts, some disabled, unverified, with a second factor or
            with claims, imported into {tenant ? `tenant ${tenant}` : 'the project’s users'}: no
            triggers fire.
          </Dialog.Description>
          <div className="-mx-1 mt-4 grid min-h-0 gap-4 overflow-y-auto px-1 py-1">
            <DialogField label="How many">
              <Select
                size="sm"
                value={String(count)}
                onValueChange={(value) => setCount(Number(value))}
                aria-label="How many sample users"
                className="w-40"
              >
                {SAMPLE_COUNTS.map((value) => (
                  <Select.Option key={value} value={String(value)}>
                    {formatNumber(value)}
                  </Select.Option>
                ))}
              </Select>
            </DialogField>
            <p className="m-0 text-[13px] text-kumo-subtle" data-testid="sample-note">
              Each is marked as a sample: <span className="font-mono text-[0.9em]">is:sample</span>{' '}
              finds them, and Delete sample users removes exactly them. Email users sign in with{' '}
              <span className="font-mono text-[0.9em]">{SAMPLE_PASSWORD}</span>.
            </p>
            {job && (
              <Text variant="secondary" size="sm">
                <span data-testid="sample-progress">{jobProgress(job, 'imported')}</span>
              </Text>
            )}
            {make.isError && (
              <p className="text-[13px] text-kumo-danger" data-testid="sample-error">
                {refusal(make.error)}
              </p>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            {job?.state === 'running' ? (
              <Button variant="secondary" onClick={() => void cancelJob(job.id)}>
                Cancel
              </Button>
            ) : finished ? (
              <Button
                variant="primary"
                onClick={() => {
                  onDone()
                  onOpenChange(false)
                }}
                data-testid="sample-show"
              >
                Show them
              </Button>
            ) : (
              <>
                <Dialog.Close render={<Button variant="secondary">Cancel</Button>} />
                <Button
                  variant="primary"
                  onClick={() => make.mutate()}
                  loading={running}
                  disabled={blocked !== undefined}
                  data-testid="sample-go"
                >
                  Add {formatCount(count, USERS)}
                </Button>
              </>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
