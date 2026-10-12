// Row one of an open instance: which instance it is — its name, its id in
// the data face, where its source is and which version — in a field that
// runs to the end of its group with copy inside it, then whether it starts
// offline and its state, then what acts on the whole instance. Reload is
// the row's one brand-filled action, except while the configuration is
// being edited, when Save below it is the action on screen.

import { Button, Tooltip } from '@cloudflare/kumo'
import { ArrowClockwiseIcon, PackageIcon } from '@phosphor-icons/react'
import type { ExtensionInstanceSummary } from '@/api/generated/compute/ExtensionInstanceSummary'
import { LiveNotice } from '@/components/console/live-notice'
import { ToolbarDivider, ToolbarField, ToolbarRow } from '@/components/console/toolbar'
import { CopyButton } from '@/components/console/copy-button'
import { PanelToggle } from '@/components/shell/section-panel'
import { StatusDot } from '@/components/kit'
import type { SubscriptionStatus } from '@/lib/live/channel'
import { liveChannel } from '@/lib/live/channel'
import { instanceTitle, originWord, readiness, stateChip } from '../words'

export function InstanceToolbar({
  summary,
  live,
  editing,
  reloading,
  onReload,
  onVendor,
}: {
  summary: ExtensionInstanceSummary
  live: SubscriptionStatus
  editing: boolean
  reloading: boolean
  onReload: () => void
  onVendor: () => void
}) {
  const title = instanceTitle(summary)
  const ready = readiness(summary)
  const state = stateChip(summary)
  const where = summary.sourceDir ?? summary.written
  return (
    <ToolbarRow testId="instance-toolbar">
      <PanelToggle where="toolbar" />
      <ToolbarField
        testId="instance-identity"
        trailing={
          <CopyButton
            value={summary.instanceId}
            label="Copy the instance id"
            testId="instance-copy"
          />
        }
      >
        <span className="flex min-w-0 items-baseline gap-2 text-[12px]">
          {title !== summary.instanceId && (
            <span className="shrink-0 font-medium text-kumo-default">{title}</span>
          )}
          <span className="shrink-0 font-mono text-kumo-default" data-testid="instance-id">
            {summary.instanceId}
          </span>
          <Tooltip
            content={summary.written === where ? where : `${summary.written} · ${where}`}
            render={
              <span className="min-w-0 truncate text-kumo-subtle">
                {originWord(summary)} <span className="font-mono">{where}</span>
                {summary.version ? (
                  <>
                    {' · '}
                    <span className="font-mono">{summary.version}</span>
                  </>
                ) : null}
              </span>
            }
          />
        </span>
      </ToolbarField>
      <ToolbarDivider />
      <LiveNotice status={live} what="the instances" onRetry={() => liveChannel.retry()} />
      <Tooltip
        content={ready.note}
        render={
          <span className="flex shrink-0 items-center px-1" data-testid="instance-readiness">
            <StatusDot tone={ready.tone} label={ready.word} />
          </span>
        }
      />
      {state && (
        <Tooltip
          content={summary.error ?? 'The instance is loading.'}
          render={
            <span className="flex shrink-0 items-center px-1" data-testid="instance-state">
              <StatusDot tone={state.tone} label={state.word} pulse={summary.state === 'loading'} />
            </span>
          }
        />
      )}
      {summary.kind === 'registry' && (
        <Tooltip
          content={
            summary.origin === 'vendored'
              ? 'Copy the source into extensions/.sources again'
              : 'Keep a copy of the source in extensions/.sources, so the instance starts offline'
          }
          render={
            <Button
              variant="ghost"
              size="sm"
              icon={<PackageIcon />}
              onClick={onVendor}
              className="shrink-0"
              data-testid="instance-vendor"
            >
              Vendor
            </Button>
          }
        />
      )}
      <ToolbarDivider />
      <Tooltip
        content="Load the instance again from its source and parameter files"
        render={
          <Button
            variant={editing ? 'secondary' : 'primary'}
            size="sm"
            icon={<ArrowClockwiseIcon />}
            onClick={onReload}
            loading={reloading}
            className="shrink-0"
            data-testid="instance-reload"
          >
            Reload
          </Button>
        }
      />
    </ToolbarRow>
  )
}
