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
// drop is said once, there, not again on every page.

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
import type { CSSProperties, ReactNode } from 'react'
import { Suspense, lazy, useState } from 'react'
import { statusQuery } from '@/api/queries'
import { engineBuild, engineVersion } from '@/lib/engine'
import { Kbd } from '@/components/kit'
import { useLayout } from '@/lib/layout'
import { useLiveStatus } from '@/lib/live/channel'
import { useShellLive } from '@/lib/live/shell'
import { AREA_LABELS, SECTIONS, type ServiceArea } from '@/lib/services'
import { useConsoleUi } from '@/lib/store'
import { SHELL_SCOPE, describeKey, useShortcutListener, useShortcuts } from '@/lib/shortcuts'
import { consoleToasts } from '@/lib/toasts'
import { CommandPalette } from './command-palette'
import { ThemePicker } from './theme-picker'

const AREAS: readonly ServiceArea[] = ['data', 'compute', 'messaging', 'observe']

/** The `?` dialog, loaded the first time it is opened: no page needs it to start. */
const ShortcutsDialog = lazy(() =>
  import('@/components/console/shortcuts-dialog').then((module) => ({
    default: module.ShortcutsDialog,
  })),
)

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
        <CommandPalette />
        {shortcutsLoaded && (
          <Suspense fallback={null}>
            <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          </Suspense>
        )}
      </TooltipProvider>
    </Toasty>
  )
}

function Navigation() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const go = (to: string) => (event: React.MouseEvent<HTMLButtonElement>) => {
    // Plain clicks navigate in place; modified clicks keep the browser's
    // open-in-new-tab behaviour through the real href.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    void navigate({ to })
  }
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))

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
              onClick={go('/')}
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
                  // A section of several pages is a heading over them, as
                  // Kumo files a group: open by default, so its pages are
                  // in sight without a click, and the page you are on is
                  // the one lit — the heading itself is not a place.
                  <Sidebar.MenuItem key={section.to}>
                    <Sidebar.Collapsible defaultOpen>
                      <Sidebar.CollapsibleTrigger
                        render={
                          <Sidebar.MenuButton
                            icon={section.icon}
                            tooltip={section.label}
                            data-testid={`nav-${section.label.toLowerCase()}`}
                          >
                            {section.label}
                            <Sidebar.MenuChevron />
                          </Sidebar.MenuButton>
                        }
                      />
                      <Sidebar.CollapsibleContent>
                        <Sidebar.MenuSub>
                          {section.pages.map((page) => (
                            <Sidebar.MenuSubButton
                              key={page.to}
                              href={`/console${page.to}`}
                              active={
                                page.exact
                                  ? pathname === page.to || pathname === `${page.to}/`
                                  : isActive(page.to)
                              }
                              onClick={go(page.to)}
                              data-testid={`nav-page-${page.label.toLowerCase()}`}
                            >
                              {page.label}
                            </Sidebar.MenuSubButton>
                          ))}
                        </Sidebar.MenuSub>
                      </Sidebar.CollapsibleContent>
                    </Sidebar.Collapsible>
                  </Sidebar.MenuItem>
                ) : (
                  <Sidebar.MenuButton
                    key={section.to}
                    icon={section.icon}
                    tooltip={section.label}
                    href={`/console${section.to}`}
                    active={isActive(section.to)}
                    onClick={go(section.to)}
                  >
                    {section.label}
                  </Sidebar.MenuButton>
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
 * connections as it takes. An engine of another build than this page's asks
 * for a reload instead: the page's code no longer matches it.
 */
function EngineBadge() {
  const status = useQuery(statusQuery)
  const live = useLiveStatus((state) => state.status)
  const updated = useLiveStatus((state) => state.engineUpdated)
  if (updated) {
    return (
      <Tooltip
        content="The engine was updated. Reload to get its console."
        render={
          <button
            type="button"
            className="cursor-pointer rounded-md"
            onClick={() => window.location.reload()}
            data-testid="engine-badge"
          >
            <Badge variant="neutral" appearance="dot">
              engine updated · reload
            </Badge>
          </button>
        }
      />
    )
  }
  const said = (variant: 'warning' | 'error' | 'neutral', label: string, why: string) => (
    <Tooltip
      content={why}
      render={
        <span data-testid="engine-badge" data-state={live}>
          <Badge variant={variant} appearance="dot">
            {label}
          </Badge>
        </span>
      }
    />
  )
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
  return (
    <span title={engineBuild(status.data.engine)} data-testid="engine-badge" data-state={live}>
      <Badge variant="success" appearance="dot">
        engine {engineVersion(status.data.engine)}
      </Badge>
    </span>
  )
}
