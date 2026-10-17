// The shell: one bar across the whole window on top — Firenook, the
// project and "Connect your app" (`connect/`), and at its end the live
// channel's trouble when it has any, help, search and the theme — and
// beneath it
// three columns: the primary navigation, the section panel (the column a
// section can fill through `SectionPanel`) and the content. The navigation
// is expanded or collapsed to icons under the bar; collapsed, it slides its
// labels out over the page while the pointer is on it, and never over the
// bar (Kumo's `contained`, which places the peek inside its column). The control at its
// foot and `[` flip it; `t` hides and shows the panel. The shell also holds
// the console's one keydown listener (`lib/shortcuts.ts`): its own keys,
// ⌘K, `[`, `t` and `?`, and every page's, go through the same registry;
// and its one live subscription (`lib/live/shell.ts`), whose channel the
// engine badge speaks for: the whole console shares one connection, so a
// drop is said once, there, not again on every page, and a channel that is
// simply live says nothing. The badge and the engine's version, written
// small at the navigation's foot, lead to the Overview's engine section
// (`/#engine`), where the engine's facts are drawn once. The navigation draws
// each section's state from the engine's status (absent sections dimmed,
// starting ones with a pulsing dot) and its badges; a section's own shell
// piece (`shellMount`) and the suite jobs watch mount here, lazily, so no
// section edits this file.

import {
  InlineCopyText,
  Sidebar,
  Text,
  Toasty,
  Tooltip,
  TooltipProvider,
  cn,
  useSidebar,
} from '@cloudflare/kumo'
import { CubeIcon, GaugeIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import type {
  CSSProperties,
  ComponentType,
  LazyExoticComponent,
  ReactElement,
  ReactNode,
} from 'react'
import { Suspense, lazy, useEffect, useState } from 'react'
import type { SectionStatus } from '@/api/generated/SectionStatus'
import { statusQuery } from '@/api/queries'
import { useNavBadge } from '@/lib/badges'
import { ConnectButton } from '@/connect/connect-button'
import { engineBuild, engineVersion, engineVersionShort } from '@/lib/engine'
import { FirenookLogo, Kbd, NavBadge, NavIconWithDot } from '@/components/kit'
import { NARROW_BELOW, panelShown, useLayout } from '@/lib/layout'
import { useLiveStatus } from '@/lib/live/channel'
import { useShellLive } from '@/lib/live/shell'
import {
  AREA_LABELS,
  type ConsoleSection,
  SECTIONS,
  type SectionLink,
  type ServiceArea,
  itemBadges,
} from '@/lib/services'
import { useConsoleUi } from '@/lib/store'
import { SHELL_SCOPE, describeKey, useShortcutListener, useShortcuts } from '@/lib/shortcuts'
import { consoleToasts } from '@/lib/toasts'
import { HelpButton } from './help-button'
import { LIVE_BADGE, LiveBadgeFace, liveTrouble } from './live-badge'
import { ENGINE_DETAILS_HREF, openOverviewPart } from './overview-parts'
import { ThemePicker } from './theme-picker'

const AREAS: readonly ServiceArea[] = ['data', 'compute', 'messaging', 'observe']

/** The `?` dialog, loaded the first time it is opened: no page needs it to start. */
const ShortcutsDialog = lazy(() =>
  import('@/components/console/shortcuts-dialog').then((module) => ({
    default: module.ShortcutsDialog,
  })),
)

/**
 * ⌘K, loaded when the browser is idle after the first paint, or at once
 * when it is asked for first: the palette and its engine search are not
 * what a page needs to start.
 */
const CommandPalette = lazy(() =>
  import('./command-palette').then((module) => ({ default: module.CommandPalette })),
)

/** The help menu, which needs Kumo's menu: its button is drawn until it arrives. */
const HelpMenu = lazy(() => import('./help-menu').then((module) => ({ default: module.HelpMenu })))

/** Toasts for suite jobs in every tab; nothing on screen needs it to start. */
const JobsWatch = lazy(() =>
  import('./jobs-watch').then((module) => ({ default: module.JobsWatch })),
)

/** Each section's `shellMount`, made lazy once. */
const SHELL_MOUNTS = new Map<string, LazyExoticComponent<ComponentType>>()
function shellMountOf(section: ConsoleSection): LazyExoticComponent<ComponentType> | undefined {
  if (!section.shellMount) return undefined
  let mounted = SHELL_MOUNTS.get(section.id)
  if (!mounted) {
    mounted = lazy(section.shellMount)
    SHELL_MOUNTS.set(section.id, mounted)
  }
  return mounted
}

/** A registry link as an address in this console, for the nav's real `href`. */
export function hrefOf(link: SectionLink): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(link.search ?? {}))
    if (value !== undefined && value !== false && value !== '') search.set(key, String(value))
  const query = search.size > 0 ? `?${search}` : ''
  return `/console${link.to}${query}`
}

/** The section panel's width, px. */
export const PANEL_WIDTH = 264

/**
 * The navigation's widths. Expanded, 248 px: Kumo's default is 16.25rem; the
 * labels here are short (the longest is "Authentication"), so the nav gives
 * a little back to the data. 14rem fit the labels but crowded them against
 * a section's count and chevron, and left the version at its foot no room.
 *
 * Collapsed to icons, a rail as wide as one square button and its gutters.
 * Kumo's rail is 57 px with 11 px gutters, fixed, around a button sized in
 * rem; drawn for a 16 px root, the button is a 34 px square with its icon
 * in the middle. Here the root is 14 px, so the button shrank to 30 px tall
 * and its icon to 14 px while the rail kept its width: every highlight was
 * a 34 by 30 box with the icon 2.5 px left of its centre. The button's
 * height (2.125rem), both gutters and the rail's border make it square
 * again, with the icon centred.
 */
const NAV_WIDTH: CSSProperties = {
  '--sidebar-width': '15.5rem',
  '--sidebar-width-icon': 'calc(2.125rem + 2 * 11px + 1px)',
} as CSSProperties

/** A page label as a test id's tail: "All functions" → `all-functions`. */
function slug(label: string): string {
  return label.toLowerCase().replaceAll(' ', '-')
}

export function AppShell({ children }: { children: ReactNode }) {
  const togglePalette = useConsoleUi((state) => state.togglePalette)
  const navOpen = useLayout((state) => state.navOpen)
  const setNavOpen = useLayout((state) => state.setNavOpen)
  const toggleNav = useLayout((state) => state.toggleNav)
  const togglePanel = useLayout((state) => state.togglePanel)
  const panel = useLayout((state) => state.panel)
  const panelOpen = useLayout(panelShown)
  const setSlot = useLayout((state) => state.setSlot)
  const setNarrow = useLayout((state) => state.setNarrow)
  // Below `xl` an open inspector floats over the list, and the panel steps
  // aside for it (`lib/layout.ts`).
  useEffect(() => {
    const query = globalThis.matchMedia?.(`(max-width: ${NARROW_BELOW - 0.02}px)`)
    if (!query) return
    setNarrow(query.matches)
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [setNarrow])

  const paletteOpen = useConsoleUi((state) => state.paletteOpen)
  const [paletteLoaded, setPaletteLoaded] = useState(false)
  if (paletteOpen && !paletteLoaded) setPaletteLoaded(true)
  useEffect(() => {
    // Fetch the palette's code once the page is idle, so the first ⌘K is instant.
    const load = () => void import('./command-palette')
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(load, { timeout: 5000 })
      return () => cancelIdleCallback(id)
    }
    const timer = setTimeout(load, 2000)
    return () => clearTimeout(timer)
  }, [])

  const shortcutsOpen = useConsoleUi((state) => state.shortcutsOpen)
  const setShortcutsOpen = useConsoleUi((state) => state.setShortcutsOpen)
  const toggleShortcuts = useConsoleUi((state) => state.toggleShortcuts)
  // The dialog's code arrives the first time it is asked for, and stays.
  const [shortcutsLoaded, setShortcutsLoaded] = useState(false)
  if (shortcutsOpen && !shortcutsLoaded) setShortcutsLoaded(true)

  // The console's one keydown listener; every page's keys go through it.
  useShortcutListener()
  // The engine's status and badges, live, for every page.
  useShellLive()
  useShortcuts({ id: SHELL_SCOPE, label: 'Everywhere' }, [
    { key: 'Mod+k', label: 'Search the console', run: togglePalette, allowInInputs: true },
    { key: '[', label: 'Collapse or expand the sidebar', run: toggleNav },
    {
      key: 't',
      label: panel.present
        ? `Hide or show the ${panel.label.toLowerCase()} panel`
        : 'Hide or show the panel',
      run: togglePanel,
      when: () => useLayout.getState().panel.present,
    },
    { key: '?', label: 'Keyboard shortcuts', run: toggleShortcuts },
  ])

  return (
    // Toasts raised outside React (a timer, a live handler) reach the same
    // stack through `consoleToasts`, under the one policy in `lib/toasts.ts`.
    <Toasty toastManager={consoleToasts}>
      <TooltipProvider>
        <div className="flex h-full flex-col">
          <TopBar />
          <div className="flex min-h-0 flex-1">
            {/* Only the navigation lives inside Kumo's provider, and the
                wrapper sits above the content so a peek overlays it. */}
            <Sidebar.Provider
              open={navOpen}
              onOpenChange={setNavOpen}
              peekable
              contained
              collapsible="icon"
              className="z-30 h-full min-h-0 w-auto shrink-0"
              style={NAV_WIDTH}
            >
              <Navigation />
            </Sidebar.Provider>
            <div className="flex min-w-0 flex-1 bg-kumo-canvas">
              <aside
                ref={setSlot}
                aria-label={panel.label || undefined}
                className={
                  panel.present && panelOpen
                    ? 'flex min-h-0 shrink-0 flex-col border-r border-kumo-line bg-kumo-base'
                    : 'hidden'
                }
                style={{ width: PANEL_WIDTH }}
                data-testid="section-panel"
              />
              <main className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
                {children}
              </main>
            </div>
          </div>
        </div>
        {paletteLoaded && (
          <Suspense fallback={null}>
            <CommandPalette />
          </Suspense>
        )}
        <Suspense fallback={null}>
          <JobsWatch />
          <ShellMounts />
        </Suspense>
        {shortcutsLoaded && (
          <Suspense fallback={null}>
            <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          </Suspense>
        )}
      </TooltipProvider>
    </Toasty>
  )
}

/** Each ready section's own shell piece (`shellMount`): toasts, palette entries. */
function ShellMounts() {
  const status = useQuery(statusQuery)
  if (!status.data) return null
  const ready = new Set(
    status.data.sections.filter((entry) => entry.state === 'ready').map((entry) => entry.id),
  )
  return (
    <>
      {SECTIONS.filter((section) => ready.has(section.id)).map((section) => {
        const Mounted = shellMountOf(section)
        return Mounted ? <Mounted key={section.id} /> : null
      })}
    </>
  )
}

function Navigation() {
  const status = useQuery(statusQuery)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))
  const go = useGo()
  const entries = new Map(status.data?.sections.map((entry) => [entry.id, entry]))

  return (
    <Sidebar
      data-testid="primary-nav"
      contentClassName="group-data-[state=peeking]/sidebar:shadow-lg"
    >
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            <Sidebar.MenuButton
              icon={<NavIconWithDot icon={GaugeIcon} />}
              tooltip="Overview"
              href="/console"
              active={isActive('/')}
              onClick={go({ to: '/' })}
            >
              Overview
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Group>
        {AREAS.map((area) => (
          <Sidebar.Group key={area}>
            <Sidebar.GroupLabel>{AREA_LABELS[area]}</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {SECTIONS.filter((section) => section.area === area).map((section) =>
                // A section the engine does not run is one dimmed item that
                // says why and leads to its gate: its pages have nothing to show.
                section.pages && entries.get(section.id)?.state !== 'absent' ? (
                  <SectionWithPages
                    key={section.id}
                    section={section}
                    entry={entries.get(section.id)}
                    pathname={pathname}
                  />
                ) : (
                  <SectionItem
                    key={section.id}
                    section={section}
                    entry={entries.get(section.id)}
                    active={isActive(section.to)}
                  />
                ),
              )}
            </Sidebar.Menu>
          </Sidebar.Group>
        ))}
      </Sidebar.Content>
      <Sidebar.Footer>
        <NavToggle />
        <NavVersion />
      </Sidebar.Footer>
    </Sidebar>
  )
}

/**
 * A click handler that navigates in place: plain clicks go through the
 * router, modified ones keep the browser's open-in-new-tab behaviour
 * through the real `href`.
 */
function useGo() {
  const navigate = useNavigate()
  return (link: SectionLink) => (event: React.MouseEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    void navigate({ to: link.to, search: link.search } as never)
  }
}

/** The sentence a section's state reads in the nav's tooltip, when it is not ready. */
function stateTooltip(
  section: ConsoleSection,
  entry: SectionStatus | undefined,
): string | undefined {
  if (entry?.state === 'absent')
    return `${section.label} is not running — open it to see how to start it`
  if (entry?.state === 'starting') return entry.detail ?? `${section.label} is starting`
  return undefined
}

/** A section's item, wrapped in the tooltip its state reads when it is not ready. */
function WithStateTooltip({
  section,
  entry,
  children,
}: {
  section: ConsoleSection
  entry: SectionStatus | undefined
  children: ReactElement
}) {
  const sentence = stateTooltip(section, entry)
  if (!sentence) return children
  return <Tooltip content={sentence} side="right" render={children} />
}

/** A section of one page: its icon (with the collapsed nav's dot), label and badge. */
function SectionItem({
  section,
  entry,
  active,
}: {
  section: ConsoleSection
  entry: SectionStatus | undefined
  active: boolean
}) {
  const go = useGo()
  const badge = useNavBadge(itemBadges(section))
  // While a counter badge is up, the item leads to what is new.
  const link: SectionLink =
    badge?.counter && section.badgeLink ? section.badgeLink(badge.seen) : { to: section.to }
  const state = entry?.state ?? 'ready'
  return (
    <Sidebar.MenuItem>
      <WithStateTooltip section={section} entry={entry}>
        <Sidebar.MenuButton
          icon={
            <NavIconWithDot
              icon={section.icon}
              tone={state === 'starting' ? 'starting' : badge?.tone}
              testId={`nav-dot-${section.id}`}
            />
          }
          href={hrefOf(link)}
          active={active}
          onClick={go(link)}
          className={state === 'absent' ? 'text-kumo-inactive' : ''}
          data-testid={`nav-${section.id}`}
          data-state={state}
        >
          <span className="truncate">{section.label}</span>
          <NavBadge ids={itemBadges(section)} testId={`nav-badge-${section.id}`} />
        </Sidebar.MenuButton>
      </WithStateTooltip>
    </Sidebar.MenuItem>
  )
}

/**
 * A section of several pages is a heading over them, as Kumo files a group:
 * open by default, so its pages are in sight without a click, and the page
 * you are on is the one lit — the heading itself is not a place. Each page
 * carries its own badges; collapsed to icons, the heading's icon carries a
 * dot when any of them is up.
 */
function SectionWithPages({
  section,
  entry,
  pathname,
}: {
  section: ConsoleSection
  entry: SectionStatus | undefined
  pathname: string
}) {
  const go = useGo()
  const pages = section.pages ?? []
  const everyBadge = [...itemBadges(section), ...pages.flatMap((page) => page.badges ?? [])]
  const badge = useNavBadge(everyBadge)
  const state = entry?.state ?? 'ready'
  // The section's id, as its single-entry form has it: `nav-auth` names
  // Authentication whether it is a heading over pages or a single entry.
  const testId = `nav-${section.id}`
  return (
    <Sidebar.MenuItem>
      <Sidebar.Collapsible defaultOpen>
        <WithStateTooltip section={section} entry={entry}>
          <Sidebar.CollapsibleTrigger
            render={
              <Sidebar.MenuButton
                icon={
                  <NavIconWithDot
                    icon={section.icon}
                    tone={state === 'starting' ? 'starting' : badge?.tone}
                    testId={`nav-dot-${section.id}`}
                  />
                }
                className={state === 'absent' ? 'text-kumo-inactive' : ''}
                data-testid={testId}
                data-state={state}
              >
                <span className="truncate">{section.label}</span>
                <NavBadge ids={itemBadges(section)} testId={`nav-badge-${section.id}`} />
                <Sidebar.MenuChevron />
              </Sidebar.MenuButton>
            }
          />
        </WithStateTooltip>
        <Sidebar.CollapsibleContent>
          <Sidebar.MenuSub>
            {pages.map((page) => (
              <Sidebar.MenuSubButton
                key={page.to}
                href={`/console${page.to}`}
                active={
                  page.exact
                    ? pathname === page.to || pathname === `${page.to}/`
                    : pathname.startsWith(page.to)
                }
                onClick={go({ to: page.to })}
                className={state === 'absent' ? 'text-kumo-inactive' : ''}
                data-testid={`nav-page-${slug(page.label)}`}
              >
                <span className="truncate">{page.label}</span>
                <NavBadge
                  ids={page.badges}
                  testId={`nav-badge-${section.id}-${slug(page.label)}`}
                />
              </Sidebar.MenuSubButton>
            ))}
          </Sidebar.MenuSub>
        </Sidebar.CollapsibleContent>
      </Sidebar.Collapsible>
    </Sidebar.MenuItem>
  )
}

/** Kumo's own trigger at the foot of the nav; collapsed, the nav peeks on hover. */
function NavToggle() {
  const { open } = useSidebar()
  return (
    <Tooltip
      content={
        <span className="flex items-center gap-1.5">
          {open ? 'Collapse the sidebar' : 'Expand the sidebar'}
          <Kbd>[</Kbd>
        </span>
      }
      side="right"
      render={<Sidebar.Trigger data-testid="nav-toggle" />}
    />
  )
}

/**
 * The engine's version at the navigation's foot, small, with the build in
 * its tooltip: it matters when something has to be reported or traced, not
 * while working. It leads to the Overview's engine section, where the
 * engine's facts are. Collapsed to icons, the navigation leaves it out.
 */
function NavVersion() {
  const navigate = useNavigate()
  const status = useQuery(statusQuery)
  if (!status.data) return null
  const { engine } = status.data
  return (
    <Tooltip
      content={
        <span className="grid gap-0.5">
          <span data-testid="nav-version-build">
            {engineBuild(engine) ?? `Firenook ${engineVersion(engine)}`}
          </span>
          <span className="text-kumo-subtle">Opens the engine’s details</span>
        </span>
      }
      side="top"
      render={
        <a
          href={ENGINE_DETAILS_HREF}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
            event.preventDefault()
            openOverviewPart(navigate, 'engine')
          }}
          className="ml-auto min-w-0 truncate rounded font-mono text-[11px] text-kumo-subtle outline-none hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus group-data-[state=collapsed]/sidebar:hidden"
          data-testid="nav-version"
        >
          {engineVersionShort(engine)}
        </a>
      }
    />
  )
}

function TopBar() {
  const status = useQuery(statusQuery)
  const live = useLiveStatus((state) => state.status)
  const updated = useLiveStatus((state) => state.engineUpdated)
  const setPaletteOpen = useConsoleUi((state) => state.setPaletteOpen)
  const go = useGo()
  // The console's own bar, across the whole window: where you are on the
  // left (Firenook, which opens the Overview, then the project and the way
  // to connect an app to it), and at the end what is wrong with the live
  // channel when something is, search, help and the theme. Its `data-live`
  // is the channel's state, said or not. The brand's mark is centred over
  // the collapsed navigation's column of icons (17 px in, an 18 px mark, a
  // rail whose buttons centre 26 px in), so collapsing the navigation moves
  // nothing here.
  // The section panel's toggle is the section's (`PanelToggle`), placed in
  // the panel and in the section's toolbar.
  return (
    <header
      className="flex h-12 shrink-0 items-center gap-3 border-b border-kumo-line bg-kumo-base pr-3 pl-[17px]"
      data-testid="top-bar"
      data-live={updated ? 'updated' : live}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <a
          href="/console"
          onClick={go({ to: '/' })}
          className="flex shrink-0 items-center rounded-md outline-none focus-visible:ring focus-visible:ring-kumo-focus focus-visible:ring-offset-2"
          aria-label="Firenook console: Overview"
          data-testid="top-bar-home"
        >
          <FirenookLogo className="h-[24px] w-auto" />
        </a>
        <Slash />
        <span className="flex min-w-0 items-center gap-2" data-testid="top-bar-project">
          <CubeIcon size={15} className="shrink-0 text-kumo-subtle" aria-hidden />
          {status.data ? (
            <InlineCopyText
              value={status.data.projectId}
              variant="body"
              size="sm"
              className="min-w-0 font-mono text-kumo-default"
            >
              {status.data.projectId}
            </InlineCopyText>
          ) : (
            <Text variant="mono-secondary">…</Text>
          )}
        </span>
        <ConnectButton />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <EngineBadge />
        <Suspense fallback={<HelpButton />}>
          <HelpMenu />
        </Suspense>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open the command palette"
          className="flex h-8 w-56 items-center gap-2 rounded-lg bg-kumo-base px-2.5 text-[13px] text-kumo-subtle ring ring-kumo-line outline-none hover:ink focus-visible:ring-2 focus-visible:ring-kumo-focus max-md:w-auto"
          data-testid="top-bar-search"
        >
          <MagnifyingGlassIcon size={14} aria-hidden className="shrink-0" />
          <span className="max-md:hidden">Search…</span>
          {/* ⌘K on a Mac, Ctrl+K elsewhere: the key the registry listens for. */}
          <Kbd className="ml-auto text-inherit max-md:hidden">{describeKey('Mod+k')}</Kbd>
        </button>
        <ThemePicker />
      </div>
    </header>
  )
}

/** The bar's separator between where you are and what is in it, as a path is written. */
function Slash() {
  return (
    <svg
      viewBox="0 0 12 24"
      className="h-5 w-2.5 shrink-0 text-kumo-line"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden
    >
      <path d="M9.5 3.5 2.5 20.5" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The live channel, in the bar only when something is wrong with it: amber
 * while reconnecting, red the moment the engine says it is stopping (or 30 s
 * after it vanished without a word), amber when it already serves as many
 * console connections as it takes, and a reload when the engine was updated
 * under the page (the shell banners ask for it). Live, it says nothing: the
 * pages show changes as they happen, and the engine's version is at the
 * navigation's foot. Shaped like the bar's other controls, and a link to the
 * Overview's engine section.
 */
function EngineBadge() {
  const navigate = useNavigate()
  const status = useQuery(statusQuery)
  const live = useLiveStatus((state) => state.status)
  const updated = useLiveStatus((state) => state.engineUpdated)
  const trouble = liveTrouble(live, updated, status.isError)
  if (!trouble) return null
  return (
    <Tooltip
      content={trouble.why}
      render={
        <a
          href={ENGINE_DETAILS_HREF}
          className={cn(
            LIVE_BADGE,
            'outline-none hover:ink focus-visible:ring-2 focus-visible:ring-kumo-focus',
          )}
          aria-label={`${trouble.label}: engine details`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
            event.preventDefault()
            openOverviewPart(navigate, 'engine')
          }}
          data-testid="engine-badge"
          data-state={updated ? 'updated' : live}
        >
          <LiveBadgeFace trouble={trouble} />
        </a>
      }
    />
  )
}
