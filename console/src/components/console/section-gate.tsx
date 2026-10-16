// A section's page shows only while its service can answer. "Not
// configured", "left out by --only", "follows Functions" and "starting" are
// different answers, and each gets its own (foundation spec §5.4): an
// absent section says why — the engine's `SectionStatus.reason` and
// `detail` — and how to turn it on, its `fixes`, each a block to copy; a
// starting one shows the page's shape and what it waits for, and fills in
// by itself when the shell's status says it is ready, with no reload.

import { Badge, Empty, SkeletonLine, Text } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { type ReactNode, createContext, useContext } from 'react'
import type { SectionStatus } from '@/api/generated/SectionStatus'
import { statusQuery } from '@/api/queries'
import { Page } from '@/components/shell/page'
import { useMarkSeen } from '@/lib/badges'
import { type ConsoleSection, type SectionId, type SectionPage, sectionById } from '@/lib/services'
import { CodeBlock } from './code-block'
import { ShellBanners } from './shell-banners'

/** The engine's word on a section; one it does not list is taken as ready (an older engine). */
export function sectionStatus(
  sections: readonly SectionStatus[] | undefined,
  id: SectionId,
): SectionStatus {
  return (
    sections?.find((entry) => entry.id === id) ?? {
      id,
      state: 'ready',
      reason: null,
      detail: null,
      fixes: [],
      summary: null,
    }
  )
}

/** The badge ids a page marks seen: the section's own and the open page's. */
export function seenBadges(section: ConsoleSection, pathname: string): string[] {
  // The longest page path the pathname is on: `/firestore/rules`, not `/firestore`.
  const page = section.pages
    ?.filter((candidate) =>
      candidate.exact
        ? pathname === candidate.to || pathname === `${candidate.to}/`
        : pathname === candidate.to || pathname.startsWith(`${candidate.to}/`),
    )
    .reduce<SectionPage | undefined>(
      (longest, candidate) =>
        longest === undefined || candidate.to.length > longest.to.length ? candidate : longest,
      undefined,
    )
  return [...(section.badges ?? []), ...(page?.badges ?? [])]
}

/** Renders children only when the section is ready; otherwise ServiceNotRunning / ServiceStarting. */
export function SectionGate({
  section: id,
  skeleton,
  children,
}: {
  section: SectionId
  skeleton?: ReactNode
  children: ReactNode
}) {
  const status = useQuery(statusQuery)
  const section = sectionById(id)
  if (!section) throw new Error(`No section is registered as ${id}`)
  if (!status.data) {
    // Until the engine has said, nothing: a section's page must not start
    // asking a service that may not be there. An engine that cannot be
    // reached is the engine badge's to say; the page then shows its own
    // errors as it always has.
    return status.isError ? <>{children}</> : null
  }
  const entry = sectionStatus(status.data.sections, id)
  if (entry.state === 'absent') return <ServiceNotRunning section={section} status={entry} />
  if (entry.state === 'starting')
    return <ServiceStarting section={section} status={entry} skeleton={skeleton} />
  return <ReadySection section={section}>{children}</ReadySection>
}

/** A ready section's page; its badges are seen while it is on screen. */
function ReadySection({ section, children }: { section: ConsoleSection; children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  useMarkSeen(seenBadges(section, pathname))
  return <>{children}</>
}

/** The title row both states share: the section's name, its state and what it does. */
function TitleRow({ section, state }: { section: ConsoleSection; state: 'absent' | 'starting' }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <Text variant="heading" size="lg" as="h1">
          {section.label}
        </Text>
        {state === 'absent' ? (
          <Badge variant="neutral" appearance="dot">
            not running
          </Badge>
        ) : (
          <Badge variant="warning" appearance="dot">
            starting
          </Badge>
        )}
      </div>
      <Text variant="secondary">{section.summary}</Text>
    </div>
  )
}

/** Why the section is not part of this engine, and how to turn it on. */
export function ServiceNotRunning({
  section,
  status,
}: {
  section: ConsoleSection
  status: SectionStatus
}) {
  const detail = status.detail ?? `This engine does not run ${section.label}.`
  return (
    <Page className="grid gap-6">
      <TitleRow section={section} state="absent" />
      <div data-testid="service-not-running" data-reason={status.reason ?? undefined}>
        <Empty
          icon={<section.icon size={48} className="text-kumo-inactive" />}
          title={`${section.label} is not running`}
          description={detail}
          contents={
            status.fixes.length > 0 ? (
              <div
                className="mt-2 grid w-[min(560px,100%)] gap-5 text-left"
                data-testid="section-fixes"
              >
                {status.fixes.map((fix) => (
                  <CodeBlock
                    key={`${fix.kind}:${fix.label}`}
                    label={fix.label}
                    code={fix.text}
                    language={fix.kind === 'firebase-json' ? 'json' : 'shell'}
                    testId={`fix-${fix.kind}`}
                  />
                ))}
              </div>
            ) : undefined
          }
        />
      </div>
    </Page>
  )
}

/** The page's shape while its service starts; it swaps in live when the status turns ready. */
export function ServiceStarting({
  section,
  status,
  skeleton,
}: {
  section: ConsoleSection
  status: SectionStatus
  skeleton?: ReactNode
}) {
  return (
    <Page className="grid gap-6">
      <TitleRow section={section} state="starting" />
      <div className="grid gap-4" data-testid="service-starting" aria-busy>
        {skeleton ?? (
          <div className="grid gap-3 rounded-lg px-1 py-2" aria-hidden>
            <SkeletonLine minWidth={40} maxWidth={60} />
            {Array.from({ length: 6 }, (_, index) => (
              <SkeletonLine key={index} minWidth={70} maxWidth={100} />
            ))}
          </div>
        )}
        <div className="grid gap-1">
          {status.detail && (
            <Text variant="secondary" size="sm">
              {status.detail}
            </Text>
          )}
          <Text variant="secondary" size="sm">
            The page fills in by itself when it is ready.
          </Text>
        </div>
      </div>
    </Page>
  )
}

const InFrame = createContext(false)

/**
 * Whether a `SectionFrame` is above: it has drawn the shell banners and marks
 * the page's badges seen, so a `SectionPage` inside it does neither again.
 */
export function useInSectionFrame(): boolean {
  return useContext(InFrame)
}

/**
 * What every section route renders: the suite-wide banners at the top of
 * the content column, then the section behind its gate, filling the rest.
 */
export function SectionFrame({
  section,
  projectScope,
  skeleton,
  children,
}: {
  section: SectionId
  /** Whether this page can show another project's data (default: the section's `projectScope`). */
  projectScope?: boolean
  skeleton?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ShellBanners section={section} {...(projectScope === undefined ? {} : { projectScope })} />
      <div className="relative min-h-0 flex-1 overflow-auto">
        <InFrame.Provider value>
          <SectionGate section={section} skeleton={skeleton}>
            {children}
          </SectionGate>
        </InFrame.Provider>
      </div>
    </div>
  )
}
