// The page's title and, under it, the suite in one line: whether every
// service runs (or how many start, or need attention), how long the engine
// has run, and where its data lives. The project and the engine's version
// are in the top bar on every page, so they are not said again here. The
// way to connect an app is the page's one action, at the end of the title.
// The uptime turns over with the console's shared minute clock, never a
// request.

import { Button, Text, Tooltip } from '@cloudflare/kumo'
import { PlugsConnectedIcon } from '@phosphor-icons/react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { StatusDot } from '@/components/kit'
import { useNow } from '@/lib/clock'
import { type SuiteHealth, dataWords, uptime } from '../model'

export function OverviewHeader({
  status,
  health,
  onConnect,
}: {
  status: ConsoleStatus
  health: SuiteHealth
  /** Opens "Connect your app". */
  onConnect: () => void
}) {
  const now = useNow('minute')
  const { data } = status
  const where = dataWords(data)
  return (
    <header
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3"
      data-testid="overview-header"
    >
      <div className="grid min-w-0 gap-1.5">
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
      </div>
      <Button
        variant="secondary"
        icon={<PlugsConnectedIcon />}
        onClick={onConnect}
        data-testid="overview-connect-open"
      >
        Connect your app
      </Button>
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
