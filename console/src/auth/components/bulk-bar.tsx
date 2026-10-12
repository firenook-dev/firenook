// What can be done with ticked users, in the bar laid over the filter line
// while rows are ticked: Disable, Enable, Verify email, Revoke, Claims…,
// Export, and Delete N last in red. "Select all N matching" turns the
// selection into the filter itself, so the change reaches every match when
// the job runs. Every change is one engine job; a small selection starts at
// once and says what changed, a large one (or every match) asks the engine
// for its numbers first.

import { Button, Tooltip } from '@cloudflare/kumo'
import { DownloadSimpleIcon, TrashIcon } from '@phosphor-icons/react'
import { useMutation } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Total } from '@/api/generated/Total'
import { SelectionBar } from '@/components/console/selection-bar'
import { jobProgress } from '@/components/console/danger-confirm'
import { formatNumber } from '@/lib/format'
import { useJob } from '@/lib/jobs'
import { toast } from '@/lib/toasts'
import { startBulk } from '../api'
import { SIMPLE_VERBS, type SimpleVerb, VERB_WORDS, bulkTarget, needsDryRun } from '../bulk'
import { type TenantScope, usersTenant } from '../tenant-scope'
import { refusal } from '../user-actions'
import { BulkClaimsDialog } from './bulk-claims-dialog'
import { BulkConfirm } from './bulk-confirm'
import { BulkDeleteDialog } from './bulk-delete-dialog'

type Open = { kind: 'simple'; verb: SimpleVerb } | { kind: 'claims' } | { kind: 'delete' } | null

/** Says how a job this tab started at once ended, once. */
function useStartedJobToast(jobId: string | undefined, title: string, verb: string) {
  const job = useJob(jobId)
  const said = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!job || job.state === 'running' || said.current === job.id) return
    said.current = job.id
    toast({
      key: `job:${job.id}`,
      title: job.state === 'done' ? title : `${title}: ${job.state}`,
      description: jobProgress(job, verb),
      tone: job.state === 'done' ? 'success' : job.state === 'cancelled' ? 'warning' : 'danger',
    })
  }, [job, title, verb])
}

export function useUserBulk(options: {
  project: string
  scope: TenantScope
  q: string
  selection: { checked: ReadonlySet<string>; everything: boolean }
  total: Total | undefined
  onClear: () => void
  onSelectEverything: () => void
  onExport: () => void
  blocked: string | undefined
}): { overlay: ReactNode | undefined; dialogs: ReactNode; deleteSelected: () => void } {
  const { project, scope, q, selection, total, blocked } = options
  const tenant = usersTenant(scope)
  const [open, setOpen] = useState<Open>(null)
  const [jobId, setJobId] = useState<string | undefined>(undefined)
  const [quick, setQuick] = useState<{ id: string; title: string; verb: string } | undefined>()
  useStartedJobToast(quick?.id, quick?.title ?? '', quick?.verb ?? '')
  const selecting = selection.everything || selection.checked.size > 0
  const target = bulkTarget(scope, selection, q)
  const count = selection.everything
    ? (total?.count ?? selection.checked.size)
    : selection.checked.size
  const startQuick = useMutation({
    mutationFn: (verb: SimpleVerb) => startBulk(project, verb, { target }),
    onSuccess: (job, verb) => {
      const words = VERB_WORDS[verb]
      setQuick({ id: job.id, title: words.doneTitle(count), verb: words.done })
    },
    onError: (error) =>
      toast({
        key: 'auth.bulk',
        title: 'The engine did not start the change',
        description: refusal(error),
        tone: 'danger',
      }),
  })
  const run = (verb: SimpleVerb) => {
    if (needsDryRun(target)) {
      setJobId(undefined)
      setOpen({ kind: 'simple', verb })
    } else startQuick.mutate(verb)
  }
  const deleteSelected = () => {
    if (!selecting || blocked) return
    setJobId(undefined)
    setOpen({ kind: 'delete' })
  }
  const close = (next: boolean) => {
    if (next) return
    const finished = jobId !== undefined
    setOpen(null)
    setJobId(undefined)
    if (finished) options.onClear()
  }
  const action = (label: string, onClick: () => void, testId: string) => {
    const button = (
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        disabled={blocked !== undefined}
        data-testid={testId}
      >
        {label}
      </Button>
    )
    return blocked ? (
      <Tooltip
        key={testId}
        content={blocked}
        render={<span className="inline-flex">{button}</span>}
      />
    ) : (
      <span key={testId} className="inline-flex">
        {button}
      </span>
    )
  }
  const overlay = selecting ? (
    <SelectionBar
      count={count}
      total={total}
      everything={selection.everything}
      filtered={q.trim() !== ''}
      noun={{ one: 'user', other: 'users' }}
      onSelectEverything={options.onSelectEverything}
      onClear={options.onClear}
      actions={
        <>
          {SIMPLE_VERBS.map((verb) =>
            action(VERB_WORDS[verb].button, () => run(verb), `bulk-${verb}`),
          )}
          {action(
            VERB_WORDS.setClaims.button,
            () => {
              setJobId(undefined)
              setOpen({ kind: 'claims' })
            },
            'bulk-claims',
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<DownloadSimpleIcon />}
            onClick={options.onExport}
            data-testid="bulk-export"
          >
            Export
          </Button>
          <span className="ml-auto inline-flex">
            <Button
              variant="ghost"
              size="sm"
              icon={<TrashIcon className="text-kumo-danger" />}
              onClick={deleteSelected}
              disabled={blocked !== undefined}
              data-testid="bulk-delete-button"
            >
              <span className="text-kumo-danger">Delete {formatNumber(count)}</span>
            </Button>
          </span>
        </>
      }
      testId="users-selection"
    />
  ) : undefined
  const dialogs = (
    <>
      <BulkConfirm
        open={open?.kind === 'simple'}
        onOpenChange={close}
        project={project}
        verb={open?.kind === 'simple' ? open.verb : 'disable'}
        target={target}
        count={count}
        jobId={jobId}
        onStarted={setJobId}
      />
      <BulkClaimsDialog
        open={open?.kind === 'claims'}
        onOpenChange={close}
        project={project}
        tenant={tenant}
        target={target}
        count={count}
        jobId={jobId}
        onStarted={setJobId}
      />
      <BulkDeleteDialog
        open={open?.kind === 'delete'}
        onOpenChange={close}
        project={project}
        tenant={tenant}
        target={target}
        count={count}
        jobId={jobId}
        onStarted={setJobId}
      />
    </>
  )
  return { overlay, dialogs, deleteSelected }
}
