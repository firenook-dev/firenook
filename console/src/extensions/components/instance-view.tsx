// One instance: its toolbar, its tabs and the tab on screen. The detail is
// read once and kept current by `extensions.changes` (a reload, a
// reconfigure, a vendor, a parameter file edited on disk); an instance that
// failed to load says so above the tabs, with the loader's own words.

import { SkeletonLine, Tabs } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import type { ExtensionInstanceSummary } from '@/api/generated/compute/ExtensionInstanceSummary'
import { QueryError, useDelayedFlag } from '@/components/console/empty-state'
import { SectionBanner } from '@/components/console/section-banner'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { formatNumber } from '@/lib/format'
import { instanceQuery } from '../api'
import { INSTANCE_VIEWS, type InstanceView as View } from '../search'
import { ConfigurationTab } from './configuration-tab'
import { EventsTab } from './events-tab'
import { FunctionsTab } from './functions-tab'
import { InstanceToolbar } from './instance-toolbar'
import { OverviewTab } from './overview-tab'
import { ReadmeTab } from './readme-tab'

const TAB_LABELS: Readonly<Record<View, string>> = {
  overview: 'Overview',
  configuration: 'Configuration',
  functions: 'Functions',
  events: 'Events',
  readme: 'How it works',
}

export function InstanceView({
  project,
  instance,
  listed,
  view,
  editing,
  live,
  reloading,
  onView,
  onEditingChange,
  onReload,
  onVendor,
}: {
  project: string
  instance: string
  /** The instance's row in the list, for the toolbar while the detail loads. */
  listed: ExtensionInstanceSummary | undefined
  view: View
  editing: boolean
  live: SubscriptionStatus
  reloading: boolean
  onView: (view: View) => void
  onEditingChange: (editing: boolean) => void
  onReload: () => void
  onVendor: () => void
}) {
  const detail = useQuery(instanceQuery(project, instance))
  const summary = detail.data?.summary ?? listed
  const waiting = useDelayedFlag(detail.isPending)
  if (detail.isError && !detail.data)
    return (
      <QueryError error={detail.error} onRetry={() => void detail.refetch()} section="extensions" />
    )
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="instance-view"
      data-instance={instance}
    >
      {summary && (
        <InstanceToolbar
          summary={summary}
          live={live}
          editing={editing}
          reloading={reloading}
          onReload={onReload}
          onVendor={onVendor}
        />
      )}
      {summary?.state === 'failed' && (
        <SectionBanner tone="danger" testId="instance-failed">
          <span className="font-mono text-[12px]">{instance}</span> did not load. None of its
          functions are running.
          {summary.error && (
            <span className="mt-0.5 block font-mono text-[12px] break-words text-kumo-subtle">
              {summary.error}
            </span>
          )}
        </SectionBanner>
      )}
      <div className="flex h-11 shrink-0 items-center border-b border-kumo-line px-3">
        <Tabs
          variant="underline"
          size="sm"
          value={view}
          onValueChange={(next) => onView(next as View)}
          tabs={INSTANCE_VIEWS.map((value) => ({
            value,
            label:
              value === 'functions' && summary ? (
                <span className="flex items-center gap-1.5" data-testid={`instance-tab-${value}`}>
                  {TAB_LABELS[value]}
                  <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
                    {formatNumber(summary.functionCount)}
                  </span>
                </span>
              ) : (
                <span data-testid={`instance-tab-${value}`}>{TAB_LABELS[value]}</span>
              ),
          }))}
        />
      </div>
      {detail.data ? (
        view === 'configuration' ? (
          <ConfigurationTab
            key={instance}
            project={project}
            detail={detail.data}
            editing={editing}
            onEditingChange={onEditingChange}
          />
        ) : view === 'functions' ? (
          <FunctionsTab project={project} detail={detail.data} />
        ) : view === 'events' ? (
          <EventsTab project={project} instance={instance} events={detail.data.events} />
        ) : view === 'readme' ? (
          <ReadmeTab detail={detail.data} />
        ) : (
          <OverviewTab detail={detail.data} />
        )
      ) : waiting ? (
        <div className="grid max-w-3xl gap-3 px-6 py-5" aria-busy data-testid="instance-loading">
          {Array.from({ length: 6 }, (_, index) => (
            // Placeholders have no identity of their own: their place is their name.
            <SkeletonLine key={`line-${index}`} minWidth={40} maxWidth={90} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
