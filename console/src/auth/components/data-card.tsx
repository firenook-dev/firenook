// The section's data, from one place: export, import and sample users (the
// Users page's dialogs, opened there), deleting the sample users, and the
// danger zone — every user of this tenant (a job, with or without the
// `user.delete` triggers), every user of every tenant (the section's own
// clear, `POST /suite/clear`), and the Inbox and Activity histories. Each
// destruction asks through DangerConfirm, with the functions it would run
// and how to get things back; the jobs report their progress there. Also
// what the engine keeps: the rings' sizes and whether request bodies are.

import { Button, Text } from '@cloudflare/kumo'
import { DownloadSimpleIcon, UploadSimpleIcon, UsersThreeIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { apiSend } from '@/api/client'
import type { AuthBulkPreview } from '@/api/generated/auth/AuthBulkPreview'
import type { Job } from '@/api/generated/Job'
import { statusQuery } from '@/api/queries'
import { DangerConfirm } from '@/components/console/danger-confirm'
import { formatCount, formatNumber } from '@/lib/format'
import { mergeJob, sectionJobsKey } from '@/lib/jobs'
import { toast } from '@/lib/toasts'
import { jobEndToast } from '@/components/shell/jobs-watch'
import { useTriggersFor } from '@/lib/triggers'
import { clearActivity, clearMessages, previewBulk, startBulk } from '../api'
import { summaryQuery } from '../queries'
import { type TenantScope, queryTarget } from '../tenant-scope'

/** A delete that would run triggers for more users than this is refused by the engine. */
export const TRIGGERED_LIMIT = 10_000

const USERS = { one: 'user', other: 'users' }

type Danger = 'sample' | 'tenant' | 'everything' | 'inbox' | 'activity'

/** "Inbox keeps 2,000 messages; Activity 10,000 calls; request bodies are kept…". */
export function retentionText(summary: {
  messageCapacity: number
  activityCapacity: number
  bodiesRetained: boolean
}): string {
  const bodies = summary.bodiesRetained
    ? 'request bodies are kept, in memory only (--no-diagnostics turns that off)'
    : 'request bodies are not kept: the engine runs with --no-diagnostics'
  return `The Inbox keeps the newest ${formatNumber(summary.messageCapacity)} messages and Activity the newest ${formatNumber(summary.activityCapacity)} calls; ${bodies}.`
}

export function DataCard({
  project,
  scope,
}: {
  project: string
  /** The tenant (or the project's users) the page shows. */
  scope: TenantScope
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const status = useQuery(statusQuery)
  const summary = useQuery({ ...summaryQuery(project), enabled: project !== '' })
  const tenant = scope.kind === 'tenant' ? scope.tenant : undefined
  const triggers = useTriggersFor('auth', tenant ?? '', 'user.delete')
  const [danger, setDanger] = useState<Danger | undefined>(undefined)
  const [withoutTriggers, setWithoutTriggers] = useState(true)
  const [preview, setPreview] = useState<AuthBulkPreview | undefined>(undefined)
  const [jobId, setJobId] = useState<string | undefined>(undefined)

  const toUsers = (search: Record<string, string>) =>
    void navigate({
      to: '/auth' as never,
      search: {
        ...search,
        ...(tenant ? { tenant } : {}),
        ...(project !== status.data?.projectId && project !== '' ? { project } : {}),
      } as never,
    })

  const open = async (which: Danger) => {
    setPreview(undefined)
    setJobId(undefined)
    setWithoutTriggers(true)
    setDanger(which)
    if (which === 'sample' || which === 'tenant') {
      try {
        setPreview(
          await previewBulk(project, 'delete', {
            target: queryTarget(scope, which === 'sample' ? 'is:sample' : ''),
            triggers: false,
          }),
        )
      } catch {
        // The confirm still works without the figure.
      }
    }
  }

  const run = useMutation({
    mutationFn: async (which: Danger): Promise<Job | undefined> => {
      if (which === 'inbox') {
        await clearMessages(project)
        return undefined
      }
      if (which === 'activity') {
        await clearActivity(project)
        return undefined
      }
      if (which === 'everything')
        return apiSend<Job>('POST', '/suite/clear', { sections: ['auth'] })
      return startBulk(project, 'delete', {
        target: queryTarget(scope, which === 'sample' ? 'is:sample' : ''),
        triggers: which === 'tenant' ? !withoutTriggers : false,
      })
    },
    onSuccess: (job) => {
      if (!job) {
        setDanger(undefined)
        return
      }
      setJobId(job.id)
      // This tab started the job, so its ending is news here however fast it
      // came. JobsWatch says nothing of a job it first saw finished, and the
      // jobs topic can beat this answer: told it is running, the shell's
      // suite toast follows it to the end; already finished, it is said here,
      // under the same key and in the same words.
      const key = sectionJobsKey(job.section)
      const known = queryClient.getQueryData<Job[]>(key)?.find((entry) => entry.id === job.id)
      if (known === undefined)
        queryClient.setQueryData<Job[]>(key, (list) => mergeJob(list ?? [], job))
      else if (known.state !== 'running') toast(jobEndToast(known))
    },
  })

  const count = preview?.matched
  const users = count === undefined ? 'every user' : formatCount(count, USERS)
  const where = tenant ? `tenant ${tenant}` : 'the project'
  const overLimit = !withoutTriggers && count !== undefined && count > TRIGGERED_LIMIT
  const dialog: Record<
    Danger,
    { title: string; description: ReactNode; consequences: ReactNode[] }
  > = {
    sample: {
      title:
        count === undefined
          ? 'Delete sample users'
          : `Delete ${formatCount(count, { one: 'sample user', other: 'sample users' })}`,
      description: `Every user of ${where} whose uid starts sample- (is:sample), and no other.`,
      consequences: [
        'Sample users were imported without triggers, so none run for their deletion.',
      ],
    },
    tenant: {
      title: `Delete ${users} of ${where}`,
      description: tenant
        ? `Every account of tenant ${tenant}; the tenant itself stays.`
        : 'Every account of the project’s own users; tenants keep theirs.',
      consequences: [
        overLimit
          ? `A delete that runs your user.delete triggers is limited to ${formatNumber(TRIGGERED_LIMIT)} users per action; delete without triggers, or narrow it on the Users page.`
          : 'Export them first to get them back: an export loads back with Import.',
      ],
    },
    everything: {
      title: 'Delete every user of every tenant',
      description: `Every account of ${status.data?.projectId ?? 'the project'}, its own and every tenant’s, as the emulator’s delete-all does.`,
      consequences: [
        'No user.delete triggers run, and codes already sent stay usable.',
        'Export first to get them back.',
      ],
    },
    inbox: {
      title: 'Clear the inbox history',
      description: 'Removes every message from the console’s list.',
      consequences: ['Codes already sent still work until used.'],
    },
    activity: {
      title: 'Clear the activity history',
      description: 'Removes every call from the console’s list.',
      consequences: [
        'Nothing in the emulator changes: accounts, codes and tokens stay as they are.',
      ],
    },
  }
  const shown = danger === undefined ? undefined : dialog[danger]

  return (
    <div className="grid gap-4" data-testid="data-card">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<DownloadSimpleIcon />}
          onClick={() => toUsers({ dialog: 'export' })}
          data-testid="data-export"
        >
          Export users
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<UploadSimpleIcon />}
          onClick={() => toUsers({ new: 'import' })}
          data-testid="data-import"
        >
          Import users
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<UsersThreeIcon />}
          onClick={() => toUsers({ new: 'sample' })}
          data-testid="data-sample"
        >
          Add sample users
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void open('sample')}
          data-testid="data-delete-sample"
        >
          Delete sample users…
        </Button>
      </div>
      {summary.data && (
        <Text size="sm" variant="secondary">
          {retentionText(summary.data)}
        </Text>
      )}
      <div className="grid gap-2 border-t border-kumo-line pt-3">
        <Text size="sm" variant="secondary">
          Danger zone
        </Text>
        <div className="flex flex-wrap items-center gap-2">
          <DangerButton onClick={() => void open('tenant')} testId="data-delete-tenant">
            Delete all users of {where}…
          </DangerButton>
          <DangerButton onClick={() => void open('everything')} testId="data-delete-everything">
            Delete all users in every tenant…
          </DangerButton>
          <DangerButton onClick={() => void open('inbox')} testId="data-clear-inbox">
            Clear inbox history…
          </DangerButton>
          <DangerButton onClick={() => void open('activity')} testId="data-clear-activity">
            Clear activity history…
          </DangerButton>
        </div>
      </div>
      <DangerConfirm
        open={danger !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setDanger(undefined)
            run.reset()
          }
        }}
        title={shown?.title ?? ''}
        description={shown?.description ?? ''}
        consequences={shown?.consequences ?? []}
        {...(danger === 'tenant' && !withoutTriggers && typeof triggers === 'object'
          ? { triggers: { answer: triggers, times: count ?? 0 } }
          : {})}
        {...(danger === 'tenant'
          ? {
              option: {
                label: 'Delete without triggers (the emulator’s own delete-all)',
                checked: withoutTriggers,
                onChange: setWithoutTriggers,
              },
            }
          : {})}
        {...(danger === 'everything' && status.data ? { confirmText: status.data.projectId } : {})}
        {...(jobId ? { jobId } : {})}
        pending={run.isPending}
        {...(run.error instanceof Error
          ? { error: run.error.message }
          : overLimit
            ? { error: 'Too many users for a triggered delete.' }
            : {})}
        onConfirm={() => {
          if (danger && !overLimit) run.mutate(danger)
        }}
        testId="data-confirm"
      />
    </div>
  )
}

function DangerButton({
  onClick,
  testId,
  children,
}: {
  onClick: () => void
  testId: string
  children: ReactNode
}) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} data-testid={testId}>
      <span className="text-kumo-danger">{children}</span>
    </Button>
  )
}
