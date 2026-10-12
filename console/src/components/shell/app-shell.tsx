// The shell: primary navigation on the left, the bar with the project and
// the engine on top, and beneath it two columns: the section panel (the
// column a section can fill through `SectionPanel`) and the content. The
// navigation is expanded or collapsed to icons; collapsed, it slides its
// labels out over the page while the pointer is on it. The control at its
// foot and `[` flip it; `t` hides and shows the panel. The shell also holds
// the console's one keydown listener (`lib/shortcuts.ts`): its own keys,
// ⌘K, `[`, `t` and `?`, and every page's, go through the same registry;
// and its one live subscription (`lib/live/shell.ts`), whose channel the
// engine badge speaks for: the whole console shares one connection, so a
// drop is said once, there, not again on every page. The navigation draws
// each section's state from the engine's status (absent sections dimmed,
// starting ones with a pulsing dot) and its badges; a section's own shell
// piece (`shellMount`) and the suite jobs watch mount here, lazily, so no
// section edits this file.

import {
  Badge,
  Button,
  InlineCopyText,
  Sidebar,
  Text,
  Toasty,
  Tooltip,
  TooltipProvider,
  useSidebar,
} from '@cloudflare/kumo'
import { CommandIcon, GaugeIcon } from '@phosphor-icons/react'
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
import { engineBuild, engineVersion } from '@/lib/engine'
import { Kbd, NavBadge, NavIconWithDot } from '@/components/kit'
import { useLayout } from '@/lib/layout'
import { useLiveStatus } from '@/lib/live/channel'
import { useBadges, useShellLive } from '@/lib/live/shell'
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

/** The engine badge's popover, loaded the first time the badge is clicked. */
const EnginePopover = lazy(() =>
  import('./engine-popover').then((module) => ({ default: module.EnginePopover })),
)

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
 * The navigation's expanded width. Kumo's default is 16.25rem; the labels
 * here are short (the longest is "Authentication"), so the nav gives the
 * width back to the data.
 */
const NAV_WIDTH: CSSProperties = { '--sidebar-width': '14rem' } as CSSProperties

export function AppShell({ children }: { children: ReactNode }) {
  const togglePalette = useConsoleUi((state) => state.togglePalette)
  const navOpen = useLayout((state) => state.navOpen)
  const setNavOpen = useLayout((state) => state.setNavOpen)
  const toggleNav = useLayout((state) => state.toggleNav)
  const togglePanel = useLayout((state) => state.togglePanel)
  const panel = useLayout((state) => state.panel)
  const panelOpen = useLayout((state) => state.panelOpen)
  const setSlot = useLayout((state) => state.setSlot)

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
        <div className="flex h-full">
          {/* Only the navigation lives inside Kumo's provider, and the
              wrapper sits above the content so a peek overlays it. */}
          <Sidebar.Provider
            open={navOpen}
            onOpenChange={setNavOpen}
            peekable
            collapsible="icon"
            className="z-30 h-full w-auto shrink-0"
            style={NAV_WIDTH}
          >
            <Navigation />
          </Sidebar.Provider>
          <div className="flex min-w-0 flex-1 flex-col bg-kumo-canvas">
            <TopBar />
            <div className="flex min-h-0 flex-1">
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
              <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
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
      {SECTIONS.filter((section) => section.built && ready.has(section.id)).map((section) => {
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
      <Sidebar.Header>
        <div className="flex min-w-0 items-center gap-2 px-2 py-1">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-kumo-brand text-kumo-inverse">
            <GaugeIcon size={14} weight="bold" />
          </span>
          <span className="flex min-w-0 items-center gap-2 transition-opacity duration-(--sidebar-animation-duration) group-data-[state=collapsed]/sidebar:opacity-0">
            <Text bold>Firenook</Text>
            <Text variant="secondary">console</Text>
          </span>
        </div>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            <Sidebar.MenuButton
              icon={GaugeIcon}
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
                section.pages ? (
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
  const testId = `nav-${section.label.toLowerCase()}`
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
                data-testid={`nav-page-${page.label.toLowerCase()}`}
              >
                <span className="truncate">{page.label}</span>
                <NavBadge
                  ids={page.badges}
                  testId={`nav-badge-${section.id}-${page.label.toLowerCase()}`}
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

function TopBar() {
  const status = useQuery(statusQuery)
  const setPaletteOpen = useConsoleUi((state) => state.setPaletteOpen)
  // The console's own bar. The section panel's toggle is the section's
  // (`PanelToggle`), placed in the panel and in the section's toolbar.
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-kumo-line bg-kumo-base px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Text variant="secondary" size="sm">
          Project
        </Text>
        {status.data ? (
          <InlineCopyText value={status.data.projectId} className="font-mono text-[0.9em]">
            {status.data.projectId}
          </InlineCopyText>
        ) : (
          <Text variant="mono-secondary">…</Text>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <EngineBadge />
        <ThemePicker />
        <Button
          variant="ghost"
          size="sm"
          icon={<CommandIcon />}
          onClick={() => setPaletteOpen(true)}
          aria-label="Open the command palette"
        >
          <span className="flex items-center gap-1.5">
            Search
            {/* ⌘K on a Mac, Ctrl+K elsewhere: the key the registry listens for. */}
            <Kbd className="text-inherit">{describeKey('Mod+k')}</Kbd>
          </span>
        </Button>
      </div>
    </header>
  )
}

/**
 * The engine, as the live channel knows it: its version while live; amber
 * while reconnecting, red the moment it says it is stopping (or 30 s after
 * it vanished without a word), amber when it already serves as many console
 * connections as it takes. A red dot rides on it while requests name a
 * project that is not this emulator's (the shell banner says which). An
 * engine of another build than this page's says so; the shell banners ask
 * for the reload. Clicking it opens the engine's facts and Export now.
 */
function EngineBadge() {
  const open = useConsoleUi((state) => state.enginePopoverOpen)
  const setOpen = useConsoleUi((state) => state.setEnginePopoverOpen)
  // The popover's code arrives the first time it is asked for, and stays.
  const [loaded, setLoaded] = useState(false)
  if (open && !loaded) setLoaded(true)
  const face = <EngineBadgeFace />
  const button = (
    <button
      type="button"
      className="flex cursor-pointer items-center rounded-md outline-none focus-visible:ring focus-visible:ring-kumo-focus"
      aria-label="Engine details"
      aria-haspopup="dialog"
      onClick={() => setOpen(true)}
      data-testid="engine-badge-button"
    >
      {face}
    </button>
  )
  if (!loaded) return button
  return (
    <Suspense fallback={button}>
      <EnginePopover
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button
            type="button"
            className="flex cursor-pointer items-center rounded-md outline-none focus-visible:ring focus-visible:ring-kumo-focus"
            aria-label="Engine details"
            data-testid="engine-badge-button"
          >
            {face}
          </button>
        }
      />
    </Suspense>
  )
}

function EngineBadgeFace() {
  const status = useQuery(statusQuery)
  const live = useLiveStatus((state) => state.status)
  const updated = useLiveStatus((state) => state.engineUpdated)
  const foreign = useBadges((state) => (state.badges.get('shell.foreign')?.count ?? 0) > 0)
  const face = (
    variant: 'warning' | 'error' | 'neutral' | 'success',
    label: string,
    title?: string,
  ) => (
    <span
      className="relative flex items-center"
      title={title}
      data-testid="engine-badge"
      data-state={updated ? 'updated' : live}
      data-foreign={foreign || undefined}
    >
      <Badge variant={variant} appearance="dot">
        {label}
      </Badge>
      {foreign && (
        <span
          className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-kumo-danger ring-2 ring-kumo-base"
          aria-label="Requests name another project"
          role="img"
          data-testid="engine-badge-foreign"
        />
      )}
    </span>
  )
  const said = (variant: 'warning' | 'error' | 'neutral', label: string, why: string) => (
    <Tooltip content={why} render={face(variant, label)} />
  )
  if (updated)
    return said('neutral', 'engine updated', 'The engine was updated. Reload to get its console.')
  if (live === 'reconnecting')
    return said(
      'warning',
      'reconnecting',
      'Live updates are reconnecting, so what is on screen may be out of date.',
    )
  if (live === 'offline')
    return said(
      'error',
      'engine stopped',
      'The engine stopped. The console reconnects by itself when it is back.',
    )
  if (live === 'too-many')
    return said(
      'warning',
      'too many console tabs',
      'This engine already serves 64 console connections. Close a console tab.',
    )
  if (status.isError && live === 'connecting')
    return said('error', 'engine unreachable', 'The console could not reach the engine.')
  if (!status.data || live === 'connecting')
    return said('neutral', 'connecting', 'Connecting to the engine…')
  // The engine source commit is the detail, not the headline: it only
  // matters when a version has to be traced back to a build.
  return face(
    'success',
    `engine ${engineVersion(status.data.engine)}`,
    engineBuild(status.data.engine),
  )
}
