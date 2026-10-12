// The function page's inspector: the function's name as its title, then the
// kit's segmented tabs — Run (the kind's own word: Invoke, Call, Test event,
// Run, Enqueue, Test), Trigger, Environment — written to the URL's `tab`,
// over the function's detail. Its width is remembered under
// `functions.function`; Escape and × close it.

import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { FunctionDetail } from '@/api/generated/compute/FunctionDetail'
import type { FunctionSummary } from '@/api/generated/compute/FunctionSummary'
import { QueryError } from '@/components/console/empty-state'
import { Inspector, InspectorTitle } from '@/components/console/inspector'
import { functionDetailQuery } from '../api'
import { runForm, runTabLabel } from '../kinds'
import type { FunctionTab } from '../search'
import { BlockingForm } from './blocking-form'
import { CallableForm } from './callable-form'
import { EnvironmentTab } from './environment-tab'
import { EventForm } from './event-form'
import { InvokeForm } from './invoke-form'
import { ScheduleForm } from './schedule-form'
import { TaskForm } from './task-form'
import { TriggerTab } from './trigger-tab'

/** The tabs a function's inspector offers, in order. */
export function inspectorTabs(
  summary: Pick<FunctionSummary, 'kind'>,
  withRun: boolean,
): { value: FunctionTab; label: string }[] {
  return [
    ...(withRun ? [{ value: 'run' as const, label: runTabLabel(summary.kind) }] : []),
    { value: 'trigger', label: 'Trigger' },
    { value: 'environment', label: 'Environment' },
  ]
}

export function RunSidePanel({
  project,
  summary,
  tab,
  onTab,
  onClose,
  run,
}: {
  project: string
  summary: FunctionSummary
  tab: FunctionTab
  onTab: (tab: FunctionTab) => void
  onClose: () => void
  /** The Run tab's contents, given the function's detail; absent: no Run tab. */
  run?: ((detail: FunctionDetail) => ReactNode) | undefined
}) {
  const detail = useQuery({ ...functionDetailQuery(project, summary.id), enabled: project !== '' })
  const tabs = inspectorTabs(summary, run !== undefined)
  const shown = tabs.some((entry) => entry.value === tab) ? tab : (tabs[0]?.value ?? 'trigger')
  return (
    <Inspector
      widthKey="functions.function"
      title={<InspectorTitle value={summary.id}>{summary.name}</InspectorTitle>}
      tabs={{
        items: tabs,
        value: shown,
        onChange: (next) => onTab(next as FunctionTab),
      }}
      onClose={onClose}
      closeLabel="Close the panel"
      testId="function-inspector"
    >
      {detail.error ? (
        <QueryError
          error={detail.error}
          onRetry={() => void detail.refetch()}
          section="functions"
        />
      ) : !detail.data ? (
        <div aria-busy className="min-h-0 flex-1" />
      ) : shown === 'run' && run ? (
        run(detail.data)
      ) : shown === 'environment' ? (
        <EnvironmentTab detail={detail.data} project={project} />
      ) : (
        <TriggerTab detail={detail.data} project={project} />
      )}
    </Inspector>
  )
}

/** The Run tab: the form the function's kind takes. */
export function RunTab({
  project,
  detail,
  url,
  prefill,
  onPrefilled,
  onOpenInvocation,
}: {
  project: string
  detail: FunctionDetail
  /** The function's URL as apps reach it, for kinds that answer on one. */
  url: string | undefined
  prefill?: string | undefined
  onPrefilled: () => void
  onOpenInvocation: (id: string) => void
}) {
  const form = runForm(detail.summary.kind)
  const common = { project, detail, onOpenInvocation }
  if (form === 'event') return <EventForm {...common} prefill={prefill} onPrefilled={onPrefilled} />
  if (form === 'schedule') return <ScheduleForm {...common} />
  if (form === 'task') return <TaskForm {...common} />
  if (!url)
    return (
      <p className="px-5 py-4 text-[13px] text-kumo-subtle" data-testid="run-no-url">
        This function has no address to call: the emulator does not serve it on a URL.
      </p>
    )
  if (form === 'callable')
    return <CallableForm {...common} url={url} prefill={prefill} onPrefilled={onPrefilled} />
  if (form === 'blocking') return <BlockingForm {...common} url={url} />
  return <InvokeForm {...common} url={url} prefill={prefill} onPrefilled={onPrefilled} />
}
