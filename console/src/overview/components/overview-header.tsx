// The page's title and, under it, the suite in one line: whether every
// service runs (or how many start, or need attention), how long the engine
// has run, and where its data lives. The project, the engine and the way
// to connect an app are in the top bar on every page, so they are not
// repeated here. The uptime turns over with the console's shared minute clock, never a
// request.

import { Text, Tooltip } from '@cloudflare/kumo'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { StatusDot } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { type SuiteHealth, dataWords, uptime } from '../model'

export function OverviewHeader({ status, health }: { status: ConsoleStatus; health: SuiteHealth }) {
  const now = useNow('minute')
  const { data } = status
  const where = dataWords(data)
  return (
    <header className="grid min-w-0 gap-1.5" data-testid="overview-header">
      <Text variant="heading" size="lg" as="h1">
        Overview
      </Text>
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-kumo-subtle">
        <StatusDot
          tone={health.tone}
          label={health.label}
          pulse={health.pulse}
          className="text-[13px] text-kumo-default"
          testId="overview-health"
        />
        <Dot />
        <Tooltip
          content={`Started ${new Date(status.startedAt).toLocaleString()}`}
          render={<span data-testid="overview-uptime">Up {uptime(status.startedAt, now)}</span>}
        />
        <Dot />
        <span
          className={data.mode === 'memory' ? 'text-kumo-warning' : undefined}
          data-testid="overview-data"
        >
          {where.charAt(0).toUpperCase() + where.slice(1)}
          {data.mode === 'memory' ? ', gone when the engine stops' : ''}
        </span>
      </p>
    </header>
  )
}

function Dot() {
  return (
    <span aria-hidden className="text-kumo-subtle">
      ·
    </span>
  )
}
