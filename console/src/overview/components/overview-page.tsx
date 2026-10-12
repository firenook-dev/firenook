// The console's front door (`/`): what this engine is, whether anything is
// wrong, what runs and where, the newest problems, how to connect an app,
// the data, and the engine itself — in that order, so the dangerous facts
// come first and the reference material last. Everything on it is live
// without a request of its own: section figures and badges ride the shell's
// status, the problems and the hour ride the `overview` topic, and jobs the
// `jobs` topic.

import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { statusQuery } from '@/api/queries'
import { ShellBanners } from '@/components/console/shell-banners'
import { Page } from '@/components/shell/page'
import { connectSnippet } from '@/lib/connect'
import { useBadges } from '@/lib/live/shell'
import { useRouteSearch } from '@/lib/search-params'
import { formatCount } from '@/lib/format'
import { useOverview } from '../api'
import { engineQuery } from '../queries'
import { useConnectHost } from '../host'
import { absentGroups, absentSections, infrastructure, sectionCards } from '../model'
import { useOverviewPalette } from '../palette'
import { OVERVIEW_SCROLL, revealById } from '../reveal'
import { DEFAULT_CONNECT, connectTab } from '../connect-tabs'
import type { ConnectParam, OverviewDialog, OverviewSearch } from '../search'
import { ConnectSection } from './connect'
import { DataSection } from './data-section'
import { EngineDetails } from './engine-details'
import { Infrastructure } from './infrastructure'
import { NotRunning } from './not-running'
import { Notices } from './notices'
import { OverviewHeader } from './overview-header'
import { RecentProblems } from './problems'
import type { ResetTarget } from './reset-dialog'
import { SectionCard } from './section-card'

const RUNNING = { one: 'running', other: 'running' }

export function OverviewPage() {
  const { data: status } = useSuspenseQuery(statusQuery)
  const { project, state, live } = useOverview()
  const engine = useQuery({ ...engineQuery(project), enabled: project !== '' })
  const badges = useBadges((store) => store.badges)
  const { search, update } = useRouteSearch<OverviewSearch>('/', '/')
  const [reset, setReset] = useState<ResetTarget | undefined>(undefined)
  const host = useConnectHost(status)

  const setConnect = (param: ConnectParam) =>
    update({ connect: param === DEFAULT_CONNECT ? undefined : param }, { replace: true })
  const openConnect = (param: ConnectParam | undefined) => {
    if (param) setConnect(param)
    revealById('overview-connect')
  }
  const setDialog = (dialog: OverviewDialog | undefined) =>
    update({ dialog }, { replace: dialog === undefined })

  useOverviewPalette({
    connect: openConnect,
    snippet: (param) =>
      connectSnippet(connectTab(param).target, {
        services: status.services.map((service) => service.name),
        host: host.host,
        status,
        bucket: engine.data?.config?.defaultBucket,
      }),
    save: () => setDialog('save'),
    engine: () => revealById('overview-engine'),
  })

  const cards = sectionCards(status, badges)
  const absent = absentSections(status)
  const listeners = infrastructure(status)

  return (
    // The suite-wide banners sit at the top of the content column, as on
    // every section page; the overview scrolls under them.
    <div className="flex h-full min-h-0 flex-col" data-testid="overview">
      <ShellBanners />
      <div className="min-h-0 flex-1 overflow-auto" data-testid={OVERVIEW_SCROLL}>
        <Page className="mx-auto grid w-full max-w-[1320px] gap-9 pb-12">
          <div className="grid gap-4">
            <OverviewHeader status={status} />
            {state.data && <Notices notices={state.data.notices} instance={status.instance} />}
          </div>

          <section
            className="grid gap-4"
            aria-labelledby="overview-sections-title"
            data-testid="overview-sections"
          >
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
              <h2 id="overview-sections-title" className="text-lg font-semibold">
                Sections
              </h2>
              <span className="text-[12px] text-kumo-subtle" data-testid="overview-sections-count">
                {formatCount(cards.length, RUNNING)}
                {absent.length > 0 ? ` · ${absent.length} not running` : ''}
              </span>
            </div>
            <div
              className="grid grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-3"
              data-testid="overview-cards"
            >
              {cards.map((card) => (
                <SectionCard
                  key={card.section.id}
                  card={card}
                  tick={status}
                  onConnect={openConnect}
                />
              ))}
            </div>
            {(listeners.length > 0 || absent.length > 0) && (
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-4 pt-1">
                <Infrastructure entries={listeners} />
                <NotRunning groups={absentGroups(status)} />
              </dl>
            )}
          </section>

          <RecentProblems status={status} state={state} live={live} />

          <ConnectSection
            status={status}
            engine={engine.data}
            param={search.connect}
            onParam={setConnect}
          />

          <DataSection
            status={status}
            project={project}
            dialog={search.dialog}
            reset={reset}
            onDialog={setDialog}
            onReset={setReset}
          />

          <EngineDetails status={status} project={project} details={engine} />
        </Page>
      </div>
    </div>
  )
}
