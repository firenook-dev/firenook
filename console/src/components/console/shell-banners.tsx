// The suite-wide facts no section owns (foundation spec §5.16), drawn here
// and nowhere else: background triggers a test harness paused, an app that
// writes to another project id than this emulator's, and an engine that was
// updated under the page. Every section page and the Overview render this,
// so no section draws its own variant of a suite fact.

import { Button, Popover } from '@cloudflare/kumo'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { apiSend } from '@/api/client'
import type { BackgroundTriggers } from '@/api/generated/BackgroundTriggers'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { ForeignProject } from '@/api/generated/ForeignProject'
import { statusQuery } from '@/api/queries'
import { PanelTitle } from '@/components/kit'
import { connectSnippet } from '@/lib/connect'
import { clockOrDate, formatCount } from '@/lib/format'
import { useLiveStatus } from '@/lib/live/channel'
import { useConsoleProject } from '@/lib/project'
import { type SectionId, sectionById, serviceLabel } from '@/lib/services'
import { toast } from '@/lib/toasts'
import { CodeBlock } from './code-block'
import { SectionBanner } from './section-banner'

const DISMISSED_KEY = 'firenook.console.foreign-dismissed'

function readDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeDismissed(ids: readonly string[]): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids))
  } catch {
    // Refused storage: dismissed for this page only.
  }
}

/**
 * The foreign project the banner names: the newest one this browser has not
 * put away. A new id brings the banner back.
 */
export function foreignToShow(
  foreign: readonly ForeignProject[],
  dismissed: readonly string[],
): ForeignProject | undefined {
  return foreign.find((project) => !dismissed.includes(project.projectId))
}

/** What a dropped event of each service is called, as the banner counts them. */
const DROPPED_NOUNS: Record<string, { one: string; other: string }> = {
  firestore: { one: 'Firestore change', other: 'Firestore changes' },
  auth: { one: 'Auth event', other: 'Auth events' },
  storage: { one: 'Storage event', other: 'Storage events' },
  pubsub: { one: 'Pub/Sub message', other: 'Pub/Sub messages' },
  schedule: { one: 'scheduled run', other: 'scheduled runs' },
}

/** "A", "A and B", "A, B and C". */
function listed(parts: readonly string[]): string {
  if (parts.length < 2) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * The paused banner's line: since when, and what reached no function
 * meanwhile, per service ("— since 14:02:11, 312 Firestore changes and 2
 * Storage events reached no function."); just "— since 14:02:11." while
 * nothing has been dropped.
 */
export function triggersPausedText(triggers: BackgroundTriggers, now = Date.now()): string {
  const lead = 'Background triggers are paused, so events are dropped, not queued'
  if (!triggers.since) return `${lead}.`
  const since = `${lead} — since ${clockOrDate(triggers.since, now)}`
  const counts = triggers.dropped
    .filter((entry) => entry.count > 0)
    .map((entry) =>
      formatCount(
        entry.count,
        DROPPED_NOUNS[entry.service] ?? {
          one: `${entry.service} event`,
          other: `${entry.service} events`,
        },
      ),
    )
  return counts.length === 0 ? `${since}.` : `${since}, ${listed(counts)} reached no function.`
}

/** Paused delivery matters only where functions could have run. */
function triggersPaused(status: ConsoleStatus): boolean {
  return (
    !status.backgroundTriggers.enabled &&
    status.services.some((service) => service.name === 'functions')
  )
}

export function ShellBanners({
  section,
  projectScope,
}: {
  section?: SectionId
  /** Whether this page can show another project's data (default: the section's `projectScope`). */
  projectScope?: boolean
}) {
  const status = useQuery(statusQuery)
  const updated = useLiveStatus((state) => state.engineUpdated)
  if (!status.data && !updated) return null
  return (
    <div className="flex shrink-0 flex-col" data-testid="shell-banners">
      {updated && <EngineUpdatedBanner />}
      {status.data && triggersPaused(status.data) && (
        <TriggersPausedBanner triggers={status.data.backgroundTriggers} />
      )}
      {status.data && (
        <ForeignProjectBanner
          status={status.data}
          scoped={projectScope ?? (section ? sectionById(section)?.projectScope === true : false)}
        />
      )}
    </div>
  )
}

/** The page's code no longer matches the engine: only a reload fixes that, so it cannot be put away. */
function EngineUpdatedBanner() {
  return (
    <SectionBanner
      tone="info"
      testId="banner-engine-updated"
      action={
        <Button variant="secondary" size="xs" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    >
      The engine was updated. Reload to get its console.
    </SectionBanner>
  )
}

function TriggersPausedBanner({ triggers }: { triggers: BackgroundTriggers }) {
  const client = useQueryClient()
  const [pending, setPending] = useState(false)
  const resume = async () => {
    setPending(true)
    try {
      const resumed = await apiSend<BackgroundTriggers>('POST', '/suite/background', {
        enabled: true,
      })
      // The shell topic pushes the new status too; this saves the wait.
      client.setQueryData<ConsoleStatus>(statusQuery.queryKey, (current) =>
        current ? { ...current, backgroundTriggers: resumed } : current,
      )
    } catch (error) {
      toast({
        key: 'resume-triggers',
        title: 'Background triggers were not resumed',
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setPending(false)
    }
  }
  return (
    <SectionBanner
      tone="warning"
      testId="banner-triggers-paused"
      action={
        <Button
          variant="secondary"
          size="xs"
          loading={pending}
          onClick={() => void resume()}
          data-testid="resume-triggers"
        >
          Resume
        </Button>
      }
    >
      {triggersPausedText(triggers)}
    </SectionBanner>
  )
}

function ForeignProjectBanner({ status, scoped }: { status: ConsoleStatus; scoped: boolean }) {
  const navigate = useNavigate()
  const { project: shown, foreign: viewing } = useConsoleProject()
  const [dismissed, setDismissed] = useState(readDismissed)
  const mine = status.projectId
  const setProject = (project: string | undefined) =>
    void navigate({
      to: '.',
      search: (previous: Record<string, unknown>) => {
        const { project: _shown, ...rest } = previous
        return project === undefined ? rest : { ...rest, project }
      },
    } as never)

  // Already showing another project's data: say so, and the way back.
  if (viewing && scoped) {
    return (
      <SectionBanner
        tone="info"
        testId="banner-foreign-view"
        action={
          <Button
            variant="secondary"
            size="xs"
            onClick={() => setProject(undefined)}
            data-testid="foreign-back"
          >
            Back to {mine}
          </Button>
        }
      >
        Showing project <span className="font-mono text-[0.9em]">{shown}</span>, which your app
        used; this emulator&apos;s own project is{' '}
        <span className="font-mono text-[0.9em]">{mine}</span>.
      </SectionBanner>
    )
  }

  const foreign = foreignToShow(status.foreignProjects, dismissed)
  if (!foreign) return null
  const others = status.foreignProjects.length - 1
  const dismiss = () => {
    const next = [...new Set([...dismissed, ...status.foreignProjects.map((p) => p.projectId)])]
    writeDismissed(next)
    setDismissed(next)
  }
  return (
    <SectionBanner
      tone="warning"
      testId="banner-foreign-project"
      onDismiss={dismiss}
      dismissLabel={`Hide this until another project appears`}
      action={
        scoped ? (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => setProject(foreign.projectId)}
            data-testid="foreign-show"
          >
            Show {foreign.projectId}
          </Button>
        ) : (
          <HowToFix status={status} foreign={foreign} />
        )
      }
    >
      Your app is using project <span className="font-mono text-[0.9em]">{foreign.projectId}</span>
      {others > 0 ? ` (and ${others} other${others === 1 ? '' : 's'})` : ''}; this emulator is{' '}
      <span className="font-mono text-[0.9em]">{mine}</span>, so its data is not shown here.
    </SectionBanner>
  )
}

/** The connection snippet with this emulator's project id: what the app should say instead. */
function HowToFix({ status, foreign }: { status: ConsoleStatus; foreign: ForeignProject }) {
  const running = new Set(status.services.filter((s) => s.listening).map((s) => s.name))
  const services = (
    foreign.services.length > 0 ? foreign.services : ['auth', 'firestore', 'storage', 'functions']
  ).filter((name) => running.has(name))
  const snippet = (target: 'web' | 'admin-node' | 'env') =>
    connectSnippet(target, { services: [...services, 'hub'], status })
  return (
    <Popover>
      <Popover.Trigger
        render={
          <Button variant="secondary" size="xs" data-testid="foreign-how">
            How to fix
          </Button>
        }
      />
      <Popover.Content className="grid w-[560px] max-w-[calc(100vw-2rem)] gap-3">
        <div className="grid gap-1">
          <PanelTitle>Point your app at {status.projectId}</PanelTitle>
          <p className="text-[13px] text-kumo-subtle">
            {services.length > 0
              ? `${services.map(serviceLabel).join(', ')} saw requests for ${foreign.projectId}. `
              : ''}
            Initialize the app with this emulator&apos;s project id, or start server code with{' '}
            <span className="font-mono text-[0.9em]">GCLOUD_PROJECT={status.projectId}</span>.
          </p>
        </div>
        <CodeBlock
          testId="foreign-snippet"
          dialects={[
            { id: 'web', label: 'Web', code: snippet('web') },
            { id: 'admin-node', label: 'Admin (Node.js)', code: snippet('admin-node') },
            { id: 'env', label: 'Environment', code: snippet('env') },
          ]}
        />
      </Popover.Content>
    </Popover>
  )
}
