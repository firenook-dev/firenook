// Add sample users (`?new=sample`): 10 to 10,000 realistic accounts with a
// provider mix — some disabled, unverified, with MFA and with claims — on
// `sample.test` with uids that start `sample-`, made in the page from a seed
// and imported through the engine's import (one upload, one job). No
// trigger fires; `is:sample` finds them; Delete sample users removes
// exactly them.

import { Button, Checkbox, Dialog, Select, Switch, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { jobProgress } from '@/components/console/danger-confirm'
import { formatCount, formatNumber } from '@/lib/format'
import { cancelJob, useJob } from '@/lib/jobs'
import { startImport, uploadImport } from '../api'
import { providerLabel } from '../providers'
import {
  SAMPLE_COUNTS,
  SAMPLE_PROVIDERS,
  type SampleProvider,
  cleanSeed,
  randomSeed,
  sampleFile,
  sampleUsers,
} from '../sample-users'
import { refusal } from '../user-actions'
import { DialogField, DialogInput } from './dialog-field'

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
  const [providers, setProviders] = useState<SampleProvider[]>(['password', 'phone', 'google.com'])
  const [variety, setVariety] = useState(true)
  const [password, setPassword] = useState('password-1')
  const [seed, setSeed] = useState('')
  const [jobId, setJobId] = useState<string | undefined>(undefined)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setJobId(undefined)
  }
  const make = useMutation({
    mutationFn: async () => {
      const used = cleanSeed(seed) || randomSeed()
      const users = sampleUsers({
        count,
        providers,
        variety,
        password: password || 'password-1',
        seed: used,
      })
      const preview = await uploadImport(project, tenant, sampleFile(users))
      return startImport({ importId: preview.importId, mode: 'skip' })
    },
    onSuccess: (job) => setJobId(job.id),
  })
  const job = useJob(jobId)
  const running = make.isPending || job?.state === 'running'
  const finished = job !== undefined && job.state !== 'running'
  const toggle = (provider: SampleProvider, on: boolean) =>
    setProviders((current) =>
      on ? [...new Set([...current, provider])] : current.filter((item) => item !== provider),
    )
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && running) return
        if (!next) make.reset()
        onOpenChange(next)
      }}
    >
      <Dialog size="lg" className="p-6">
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
            Sample users are imported into {tenant ? `tenant ${tenant}` : 'the project’s users'}: no
            triggers fire. <span className="font-mono text-[0.9em]">is:sample</span> finds them;
            Delete sample users removes exactly them.
          </Dialog.Description>
          <div className="-mx-1 mt-4 grid min-h-0 gap-4 overflow-y-auto px-1 py-1">
            <div className="grid grid-cols-2 gap-3">
              <DialogField label="How many">
                <Select
                  size="sm"
                  value={String(count)}
                  onValueChange={(value) => setCount(Number(value))}
                  aria-label="How many sample users"
                  className="w-full"
                >
                  {SAMPLE_COUNTS.map((value) => (
                    <Select.Option key={value} value={String(value)}>
                      {formatNumber(value)}
                    </Select.Option>
                  ))}
                </Select>
              </DialogField>
              <DialogField label="Password" hint="(every password user shares it)">
                <DialogInput value={password} onChange={setPassword} testId="sample-password" />
              </DialogField>
            </div>
            <fieldset className="grid gap-1.5">
              <Text variant="secondary" size="sm" as="span">
                Providers, mixed in equal shares
              </Text>
              <div className="grid grid-cols-3 gap-x-3 gap-y-1.5" data-testid="sample-providers">
                {SAMPLE_PROVIDERS.map((provider) => (
                  <Checkbox
                    key={provider}
                    checked={providers.includes(provider)}
                    onCheckedChange={(checked) => toggle(provider, Boolean(checked))}
                    label={
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-[12px]">{provider}</span>
                        {provider !== 'anonymous' &&
                          provider !== 'password' &&
                          provider !== 'phone' && (
                            <span className="text-[12px] text-kumo-subtle">
                              {providerLabel(provider)}
                            </span>
                          )}
                      </span>
                    }
                  />
                ))}
              </div>
            </fieldset>
            <label className="flex items-center gap-2 text-[13px] text-kumo-default">
              <Switch
                variant="neutral"
                size="sm"
                checked={variety}
                onClick={() => setVariety(!variety)}
                aria-label="Some disabled, unverified, with MFA and claims"
              />
              Some disabled, unverified, with MFA and with claims
            </label>
            <DialogField
              label="Seed"
              hint="(empty for a random one; the same seed makes the same users)"
            >
              <DialogInput
                value={seed}
                onChange={setSeed}
                placeholder="random"
                testId="sample-seed"
              />
            </DialogField>
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
                  disabled={providers.length === 0 || blocked !== undefined}
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
