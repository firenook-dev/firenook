// The shell: primary navigation on the left, the bar with the project and
// the engine on top, and beneath it two columns: the section panel (the
// column a section can fill through `SectionPanel`) and the content. The
// navigation is expanded or collapsed to icons; collapsed, it slides its
// labels out over the page while the pointer is on it. The control at its
// foot and `[` flip it; `t` hides and shows the panel.

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
import { CommandIcon, GaugeIcon, SquareHalfIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect } from 'react'
import { statusQuery } from '@/api/queries'
import { useLayout } from '@/lib/layout'
import { AREA_LABELS, SECTIONS, type ServiceArea } from '@/lib/services'
import { useConsoleUi } from '@/lib/store'
import { CommandPalette } from './command-palette'

const AREAS: readonly ServiceArea[] = ['data', 'compute', 'messaging', 'observe']

/** The section panel's width, px; the panel toggle above it shares the edge. */
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        togglePalette()
        return
      }
      const target = event.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === '[') {
        event.preventDefault()
        toggleNav()
      } else if (event.key === 't' && panel.present) {
        event.preventDefault()
        togglePanel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePalette, toggleNav, togglePanel, panel.present])

  return (
    <Toasty>
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
              {SECTIONS.filter((section) => section.area === area).map((section) => (
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
              ))}
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
      content={open ? 'Collapse the sidebar ([)' : 'Expand the sidebar ([)'}
      side="right"
      render={<Sidebar.Trigger data-testid="nav-toggle" />}
    />
  )
}

function TopBar() {
  const status = useQuery(statusQuery)
  const setPaletteOpen = useConsoleUi((state) => state.setPaletteOpen)
  const panel = useLayout((state) => state.panel)
  const panelOpen = useLayout((state) => state.panelOpen)
  const togglePanel = useLayout((state) => state.togglePanel)
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-kumo-line bg-kumo-base pr-4 pl-2">
      {panel.present && (
        <Tooltip
          content={`${panelOpen ? 'Hide' : 'Show'} the ${panel.label.toLowerCase()} panel (t)`}
          render={
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<SquareHalfIcon />}
              aria-label={`${panelOpen ? 'Hide' : 'Show'} the ${panel.label.toLowerCase()} panel`}
              aria-pressed={panelOpen}
              onClick={togglePanel}
              className={panelOpen ? 'text-kumo-default' : 'text-kumo-subtle'}
              data-testid="panel-toggle"
            />
          }
        />
      )}
      <div className={`flex min-w-0 items-center gap-2 ${panel.present ? '' : 'pl-2'}`}>
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
        <EngineBadge state={status.status} version={status.data?.engine.crateVersion} />
        <Button
          variant="ghost"
          size="sm"
          icon={<CommandIcon />}
          onClick={() => setPaletteOpen(true)}
          aria-label="Open the command palette"
        >
          <span className="flex items-center gap-1.5">
            Search
            <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1 text-[10px]">
              ⌘K
            </kbd>
          </span>
        </Button>
      </div>
    </header>
  )
}

function EngineBadge({
  state,
  version,
}: {
  state: 'pending' | 'error' | 'success'
  version?: string | undefined
}) {
  if (state === 'error') {
    return (
      <Badge variant="error" appearance="dot">
        engine unreachable
      </Badge>
    )
  }
  if (state === 'pending') {
    return (
      <Badge variant="neutral" appearance="dot">
        connecting
      </Badge>
    )
  }
  return (
    <Badge variant="success" appearance="dot">
      engine {version}
    </Badge>
  )
}
