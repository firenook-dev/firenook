// The console's front door (`/`), in the order a visit asks its questions:
// is everything running (the header's one line, and the engine's
// configuration notices under it), what holds what (a tile per section,
// each opening it), what went wrong lately (the recent problems), and
// then the two things worked on rather than read — the data (snapshot,
// reset) and the engine. Connecting an app is the header's button, a
// dialog, since it is wanted once per app. Everything on it is live
// without a request of its own: tile figures and badges ride the shell's
// status, the problems and the hour ride the `overview` topic, and jobs
// the `jobs` topic.

import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Suspense, lazy, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { ShellBanners } from '@/components/console/shell-banners'
import { Page } from '@/components/shell/page'
import { connectSnippet } from '@/lib/connect'
import { type ConnectParam, DEFAULT_CONNECT, connectTab } from '@/lib/connect-tabs'
import { useBadges } from '@/lib/live/shell'
import { useRouteSearch } from '@/lib/search-params'
import { useOverview } from '../api'
import { useConnectHost } from '../host'
import { sectionCards, sharedHost, suiteHealth } from '../model'
import { useOverviewPalette } from '../palette'
import { OVERVIEW_SCROLL, useRevealHash } from '../reveal'
import { engineQuery } from '../queries'
import type { OverviewDialog, OverviewSearch } from '../search'
import { DataSection } from './data-section'
import { EngineDetails } from './engine-details'
import { Notices } from './notices'
import { OverviewHeader } from './overview-header'
import { RecentProblems } from './problems'
import type { ResetTarget } from './reset-dialog'
import { ServiceTile } from './service-tile'

// The dialog's code loads the first time it is asked for, and stays.
const ConnectDialog = lazy(() =>
  import('./connect-dialog').then((module) => ({ default: module.ConnectDialog })),
)

export function OverviewPage() {
  const { data: status } = useSuspenseQuery(statusQuery)
  const { project, state, live } = useOverview()
  const engine = useQuery({ ...engineQuery(project), enabled: project !== '' })
  const badges = useBadges((store) => store.badges)
  const { search, update } = useRouteSearch<OverviewSearch>('/', '/')
  const [reset, setReset] = useState<ResetTarget | undefined>(undefined)
  const host = useConnectHost(status)

  const connectOpen = search.connect !== undefined
  const [connectAsked, setConnectAsked] = useState(connectOpen)
  if (connectOpen && !connectAsked) setConnectAsked(true)
  const openConnect = (param: ConnectParam = DEFAULT_CONNECT) =>
    update({ connect: param }, { replace: connectOpen })
  const closeConnect = () => update({ connect: undefined }, { replace: true })
  const setDialog = (dialog: OverviewDialog | undefined) =>
    update({ dialog, section: undefined }, { replace: dialog === undefined })

  useOverviewPalette({
    connect: () => openConnect(),
    snippet: (param) =>
      connectSnippet(connectTab(param).target, {
        services: status.services.map((service) => service.name),
        host: host.host,
        status,
        bucket: engine.data?.config?.defaultBucket,
      }),
  })
  useRevealHash()

  const cards = sectionCards(status, badges)
  const shared = sharedHost(cards)

  return (
    // The suite-wide banners sit at the top of the content column, as on
    // every section page; the overview scrolls under them. The column is
    // the containing block of everything in it, so nothing placed
    // absolutely inside can hang below the window.
    <div className="flex h-full min-h-0 flex-col" data-testid="overview">
      <ShellBanners />
      <div
        className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
        data-testid={OVERVIEW_SCROLL}
      >
        <Page className="@container mx-auto grid w-full max-w-[1200px] gap-10 pb-14">
          <div className="grid gap-4">
            <OverviewHeader
              status={status}
              health={suiteHealth(cards)}
              onConnect={() => openConnect()}
            />
            {state.data && <Notices notices={state.data.notices} instance={status.instance} />}
          </div>

          <section
            className="grid gap-3"
            aria-labelledby="overview-sections-title"
            data-testid="overview-sections"
          >
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4">
              <h2 id="overview-sections-title" className="text-[16px] leading-6 font-semibold">
                Services
              </h2>
              {shared && (
                <span className="text-[12px] text-kumo-subtle" data-testid="overview-host-shared">
                  Listening on <span className="font-mono text-kumo-default">{shared}</span>
                </span>
              )}
            </div>
            <div
              className="grid gap-3 @xl:grid-cols-2 @3xl:grid-cols-3"
              data-testid="overview-cards"
            >
              {cards.map((card) => (
                <ServiceTile key={card.section.id} card={card} host={shared} tick={status} />
              ))}
            </div>
          </section>

          <RecentProblems status={status} state={state} live={live} />

          <div className="grid items-start gap-10 @4xl:grid-cols-2 @4xl:gap-6">
            <DataSection
              status={status}
              project={project}
              dialog={search.dialog}
              section={search.section}
              reset={reset}
              onDialog={setDialog}
              onReset={setReset}
            />
            <EngineDetails status={status} details={engine} />
          </div>
        </Page>
      </div>

      {connectAsked && (
        <Suspense fallback={null}>
          <ConnectDialog
            open={connectOpen}
            onOpenChange={(open) => {
              if (!open) closeConnect()
            }}
            status={status}
            engine={engine.data}
            param={search.connect}
            onParam={(param) => update({ connect: param }, { replace: true })}
          />
        </Suspense>
      )}
    </div>
  )
}
