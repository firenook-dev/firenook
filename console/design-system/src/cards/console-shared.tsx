// The pieces the trim made one of: a section's job banners (SectionJobs)
// and a feed row's time (FeedTime), drawn by the real components on the
// console's providers, the jobs answered from the query cache and the live
// channel kept quiet, so nothing reaches for an engine.

import { Button, TooltipProvider } from '@cloudflare/kumo'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { Job } from '@/api/generated/Job'
import { statusQuery } from '@/api/queries'
import { FeedTime } from '@/components/console/feed-time'
import { SectionJobs } from '@/components/console/section-jobs'
import { sectionJobsKey } from '@/lib/jobs'
import { testStatus } from '@/test/status'
import { defineCards } from '../registry'
import { Row, Section, Stack, quietLiveChannel } from './shared'

const NOW = Date.now()

const JOBS: Job[] = [
  {
    id: 'ds-move',
    kind: 'storage.move',
    section: 'storage',
    title: 'Move users/ to archive/ · 900 files · 20 MB',
    total: 900,
    done: 412,
    skipped: 0,
    errors: [],
    errorCount: 0,
    state: 'running',
    startedAt: new Date(NOW - 6_000).toISOString(),
    finishedAt: null,
  },
  {
    id: 'ds-delete',
    kind: 'storage.delete',
    section: 'storage',
    title: 'Delete avatars/ · 40 files',
    total: 40,
    done: 37,
    skipped: 0,
    errors: [
      { key: 'avatars/u_9f3k2.png', message: 'The rules refused this delete.' },
      { key: 'avatars/u_2fc4c.png', message: 'The rules refused this delete.' },
    ],
    errorCount: 3,
    state: 'done',
    startedAt: new Date(NOW - 3_000).toISOString(),
    finishedAt: new Date(NOW - 1_000).toISOString(),
  },
  {
    id: 'ds-copy',
    kind: 'storage.copy',
    section: 'storage',
    title: 'Copy exports/ to backups/',
    total: null,
    done: 1_204,
    skipped: 0,
    errors: [],
    errorCount: 0,
    state: 'failed',
    startedAt: new Date(NOW - 9_000).toISOString(),
    finishedAt: new Date(NOW - 2_000).toISOString(),
    message: 'The engine stopped.',
  },
]

/** The providers, with the section's jobs already answered and the live channel quiet. */
function Kit({ children }: { children: ReactNode }) {
  quietLiveChannel()
  const [client] = useState(() => {
    const created = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    created.setQueryData(statusQuery.queryKey, testStatus({ projectId: 'demo-shop' }))
    created.setQueryData(sectionJobsKey('storage'), JOBS)
    return created
  })
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  )
}

const VERBS: Record<string, string> = {
  'storage.move': 'moved',
  'storage.delete': 'deleted',
  'storage.copy': 'copied',
}

/** What Storage puts beside a refused item: its rules decision, behind Why. */
function whyButton() {
  return (
    <Button variant="ghost" size="xs">
      Why
    </Button>
  )
}

function SectionJobsCard() {
  return (
    <Kit>
      <Stack>
        <Section
          title="A section's bulk work"
          note="Running: how far, a bar while the total is known, Cancel. Ended: a few seconds of what it did, warning when items failed, danger when it failed; See why lists the items with the section's own Why."
        >
          <div className="overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
            <SectionJobs
              section="storage"
              verb={(kind) => VERBS[kind] ?? 'changed'}
              why={whyButton}
              // The card keeps ended jobs on screen; the console, four seconds.
              summaryMs={7_200_000}
              testId="ds-job"
            />
            <div className="h-24" />
          </div>
        </Section>
      </Stack>
    </Kit>
  )
}

function FeedTimeCard() {
  const iso = new Date(NOW - 3_400).toISOString()
  return (
    <Kit>
      <Stack>
        <Section
          title="A feed row's time"
          note="In the console-wide clock format (time, relative or UTC), the other forms a hover away; a dash for a time it does not have."
        >
          <Row label="Clock format">
            <FeedTime iso={iso} />
          </Row>
          <Row label="No time">
            <FeedTime iso={null} />
          </Row>
        </Section>
      </Stack>
    </Kit>
  )
}

defineCards([
  {
    id: 'section-jobs',
    group: 'Patterns',
    name: 'Section jobs',
    subtitle: 'SectionJobs: a running job with Cancel, one ended with failed items, one failed',
    width: 960,
    surface: 'canvas',
    render: () => <SectionJobsCard />,
  },
  {
    id: 'section-jobs-dark',
    group: 'Patterns',
    name: 'Section jobs, dark',
    subtitle: 'The same banners in the dark theme',
    width: 960,
    surface: 'canvas',
    dark: true,
    render: () => <SectionJobsCard />,
  },
  {
    id: 'feed-time',
    group: 'Components',
    name: 'Feed time',
    subtitle: 'FeedTime: the clock setting, the other forms on hover',
    width: 560,
    surface: 'canvas',
    render: () => <FeedTimeCard />,
  },
])
