// Claims for many users at once: merged into each user's (a key set to
// `null` is removed), written over them, or some keys removed — one job,
// `POST /users:setClaims` or `:removeClaims`, its dry run first so the
// dialog says how many users it changes. A user whose claims would go over
// 1,000 characters, or carry a reserved key, is refused by the engine and
// listed with the reason.

import { Button, Dialog, Tabs, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { BulkTarget } from '@/api/generated/BulkTarget'
import { CodeEditor } from '@/components/code-editor'
import { jobProgress } from '@/components/console/danger-confirm'
import { EntityLink } from '@/components/console/entity-link'
import { formatNumber } from '@/lib/format'
import { cancelJob, useJob } from '@/lib/jobs'
import { previewBulk, startBulk } from '../api'
import { VERB_WORDS, previewSentence } from '../bulk'
import { claimsMarks, formatClaims, readClaims } from '../claims'
import { claimKeysQuery } from '../queries'
import { refusal } from '../user-actions'
import { DIALOG_INPUT, DialogField } from './dialog-field'

type ClaimsMode = 'merge' | 'replace' | 'remove'

/** The keys typed for removal: separated by commas or spaces, each once. */
export function keysToRemove(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ]
}

export function BulkClaimsDialog({
  open,
  onOpenChange,
  project,
  tenant,
  target,
  count,
  jobId,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: string
  tenant: string | undefined
  target: BulkTarget
  count: number
  jobId: string | undefined
  onStarted: (jobId: string) => void
}) {
  const [session, setSession] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setSession((value) => value + 1)
  }
  const job = useJob(jobId)
  const running = job?.state === 'running'
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && running) return
        onOpenChange(next)
      }}
    >
      <Dialog size="lg" className="p-6 sm:w-[720px]">
        <ClaimsForm
          key={session}
          project={project}
          tenant={tenant}
          target={target}
          count={count}
          jobId={jobId}
          onStarted={onStarted}
          onClose={() => onOpenChange(false)}
        />
      </Dialog>
    </Dialog.Root>
  )
}

function ClaimsForm({
  project,
  tenant,
  target,
  count,
  jobId,
  onStarted,
  onClose,
}: {
  project: string
  tenant: string | undefined
  target: BulkTarget
  count: number
  jobId: string | undefined
  onStarted: (jobId: string) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<ClaimsMode>('merge')
  const [text, setText] = useState('{\n  \n}')
  const [keysText, setKeysText] = useState('')
  const keys = useQuery({ ...claimKeysQuery(project, tenant), enabled: project !== '' })
  const reading = readClaims(text)
  // Merge may carry nulls (they remove keys); the reading refuses nothing else here.
  const claims = reading.ok ? reading.claims : undefined
  const removing = keysToRemove(keysText)
  const ready = mode === 'remove' ? removing.length > 0 : claims !== undefined
  const verb = mode === 'remove' ? 'removeClaims' : 'setClaims'
  const body =
    mode === 'remove'
      ? { target, keys: removing }
      : {
          target,
          claims: claims ?? {},
          mode: mode === 'merge' ? ('merge' as const) : ('replace' as const),
        }
  const preview = useQuery({
    queryKey: ['auth', project, 'bulk-preview', verb, JSON.stringify(body)],
    queryFn: ({ signal }) =>
      mode === 'remove'
        ? previewBulk(project, 'removeClaims', { target, keys: removing }, signal)
        : previewBulk(
            project,
            'setClaims',
            body as Parameters<typeof previewBulk<'setClaims'>>[2],
            signal,
          ),
    enabled: ready && jobId === undefined,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
  const start = useMutation({
    mutationFn: () =>
      mode === 'remove'
        ? startBulk(project, 'removeClaims', { target, keys: removing })
        : startBulk(project, 'setClaims', body as Parameters<typeof startBulk<'setClaims'>>[2]),
    onSuccess: (started) => onStarted(started.id),
  })
  const job = useJob(jobId)
  const running = start.isPending || job?.state === 'running'
  const finished = job !== undefined && job.state !== 'running'
  const words = VERB_WORDS[verb]
  return (
    <div className="flex max-h-[calc(100vh-6rem)] flex-col" data-testid="bulk-claims-dialog">
      <div className="mb-3 flex items-start justify-between gap-4">
        <Dialog.Title className="text-lg font-semibold">
          {words.title(preview.data?.matched ?? count)}
        </Dialog.Title>
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
        {mode === 'merge'
          ? 'Each user keeps their other claims; these keys are written over theirs. A key set to null is removed.'
          : mode === 'replace'
            ? 'Each user’s claims become exactly these.'
            : 'These keys are removed from each user’s claims; the rest stay.'}{' '}
        {words.explains}
      </Dialog.Description>
      <div className="mt-4 grid min-h-0 gap-3">
        <Tabs
          size="sm"
          variant="segmented"
          value={mode}
          onValueChange={(value) => setMode(value as ClaimsMode)}
          tabs={[
            { value: 'merge', label: 'Merge into each user’s claims' },
            { value: 'replace', label: 'Replace each user’s claims' },
            { value: 'remove', label: 'Remove keys' },
          ]}
        />
        {mode === 'remove' ? (
          <DialogField label="Claim keys to remove" hint="(separated by commas or spaces)">
            <input
              value={keysText}
              onChange={(event) => setKeysText(event.target.value)}
              spellCheck={false}
              placeholder={
                (keys.data?.keys ?? [])
                  .slice(0, 3)
                  .map((key) => key.key)
                  .join(', ') || 'role, plan'
              }
              className={`${DIALOG_INPUT} ring-kumo-line`}
              autoFocus
              data-testid="bulk-claims-keys"
            />
          </DialogField>
        ) : (
          <div className="flex h-48 min-h-0 flex-col">
            <CodeEditor
              value={text}
              onChange={setText}
              language="json"
              marks={claimsMarks(text)}
              jsonCompletion={{ keys: () => (keys.data?.keys ?? []).map((key) => key.key) }}
              tidyPaste={(pasted) => formatClaims(pasted)}
              autoFocus
              ariaLabel="Claims to set"
              testId="bulk-claims-text"
            />
          </div>
        )}
        {mode !== 'remove' && !reading.ok && text.trim() !== '' && (
          <p className="text-[12px] text-kumo-danger">{reading.message}</p>
        )}
        <Text variant="secondary" size="sm">
          {preview.data
            ? previewSentence(verb, preview.data)
            : ready
              ? 'Counting what would change…'
              : ' '}
        </Text>
        {preview.isError && (
          <p className="text-[13px] text-kumo-danger">{refusal(preview.error)}</p>
        )}
        {job && (
          <div className="grid gap-1" data-testid="bulk-claims-progress">
            <Text variant="secondary" size="sm">
              {jobProgress(job, words.done)}
            </Text>
            {job.errors.length > 0 && (
              <ul className="grid max-h-40 gap-1 overflow-auto rounded-md bg-kumo-tint p-2 text-[12px]">
                {job.errors.map((item, index) => (
                  <li
                    // oxlint-disable-next-line react/no-array-index-key
                    key={`${item.key}-${index}`}
                    className="grid gap-0.5"
                  >
                    <EntityLink entity={{ kind: 'auth.user', key: item.key }} />
                    <span className="text-kumo-subtle">{item.message}</span>
                  </li>
                ))}
                {job.errorCount > job.errors.length && (
                  <li className="text-kumo-subtle">
                    and {formatNumber(job.errorCount - job.errors.length)} more like these
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
        {start.isError && <p className="text-[13px] text-kumo-danger">{refusal(start.error)}</p>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        {job?.state === 'running' ? (
          <Button variant="secondary" onClick={() => void cancelJob(job.id)}>
            Cancel
          </Button>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            {finished ? 'Close' : 'Cancel'}
          </Button>
        )}
        {!finished && (
          <Button
            variant="primary"
            onClick={() => start.mutate()}
            loading={running}
            disabled={
              !ready || preview.isPending || preview.isError || (preview.data?.matched ?? 0) === 0
            }
            data-testid="bulk-claims-go"
          >
            {mode === 'remove' ? 'Remove keys' : 'Set claims'}
          </Button>
        )}
      </div>
    </div>
  )
}
