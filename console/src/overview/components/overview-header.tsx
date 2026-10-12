// What the console is talking to, in one line under the page's title: the
// project (copyable), the engine and its source, how long it has run and
// where its data lives. The uptime turns over with the console's shared
// minute clock, never a request.

import { InlineCopyText, Text, Tooltip } from '@cloudflare/kumo'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { useNow } from '@/lib/clock'
import { dataWords, engineName, uptime } from '../model'

export function OverviewHeader({ status }: { status: ConsoleStatus }) {
  const now = useNow('minute')
  const { engine, data } = status
  return (
    <header className="grid gap-1.5" data-testid="overview-header">
      <Text variant="heading" size="lg" as="h1">
        Overview
      </Text>
      <Text variant="secondary">
        <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="-mr-1 inline-flex items-baseline gap-1">
            Project
            <InlineCopyText
              value={status.projectId}
              variant="body"
              size="sm"
              className="inline-flex self-center font-mono text-kumo-default"
              data-testid="overview-project"
            >
              {status.projectId}
            </InlineCopyText>
          </span>
          <Dot />
          <span data-testid="overview-engine">
            {engineName(engine)}
            {engine.revision ? (
              <>
                {' '}
                (engine{' '}
                <span className="font-mono text-[0.9em]">{engine.revision.slice(0, 12)}</span>)
              </>
            ) : null}
          </span>
          <Dot />
          <Tooltip
            content={`Started ${new Date(status.startedAt).toLocaleString()}`}
            render={<span data-testid="overview-uptime">up {uptime(status.startedAt, now)}</span>}
          />
          <Dot />
          <span
            className={data.mode === 'memory' ? 'text-kumo-warning' : undefined}
            data-testid="overview-data"
          >
            {dataWords(data)}
          </span>
        </span>
      </Text>
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
