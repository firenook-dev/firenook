// The shell: primary navigation on the left, the bar with the project and
// the engine on top, and beneath it two columns: the section panel (the
// column a section can fill through `SectionPanel`) and the content. The
// navigation shows expanded, collapsed to icons, or collapsed until hovered;
// the person picks from the control at its foot, `[` flips it, `t` hides and
// shows the panel.

import {
  Badge,
  Button,
  DropdownMenu,
  InlineCopyText,
  Sidebar,
  Text,
  Toasty,
  Tooltip,
  TooltipProvider,
} from '@cloudflare/kumo'
import { CommandIcon, GaugeIcon, SidebarSimpleIcon, SquareHalfIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { statusQuery } from '@/api/queries'
import { NAV_MODES, type NavMode, useLayout } from '@/lib/layout'
import { AREA_LABELS, SECTIONS, type ServiceArea } from '@/lib/services'
import { useConsoleUi } from '@/lib/store'
import { CommandPalette } from './command-palette'

const AREAS: readonly ServiceArea[] = ['data', 'compute', 'messaging', 'observe']

/** The section panel's width, px; the panel toggle above it shares the edge. */
export const PANEL_WIDTH = 264

export function AppShell({ children }: { children: ReactNode }) {
  const togglePalette = useConsoleUi((state) => state.togglePalette)
  const navMode = useLayout((state) => state.navMode)
  const setNavMode = useLayout((state) => state.setNavMode)
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
          {/* Only the navigation lives inside Kumo's provider: its context
              memo misses `peekable`, so the switch between collapsed and
              hover remounts the navigation (the key) and nothing else. The
              wrapper sits above the content so a peek overlays it. */}
          <Sidebar.Provider
            key={navMode === 'hover' ? 'hover' : 'fixed'}
            open={navMode === 'expanded'}
            onOpenChange={(open) => setNavMode(open ? 'expanded' : 'collapsed')}
            peekable={navMode === 'hover'}
            collapsible="icon"
            className="z-30 h-full w-auto shrink-0"
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
        <NavModeControl />
      </Sidebar.Footer>
      <Sidebar.Rail />
    </Sidebar>
  )
}

/** Expanded, collapsed, or expand on hover: a menu at the foot of the nav. */
function NavModeControl() {
  const navMode = useLayout((state) => state.navMode)
  const setNavMode = useLayout((state) => state.setNavMode)
  const current = NAV_MODES.find((mode) => mode.value === navMode)?.label ?? 'Expanded'
  return (
    <DropdownMenu>
      <Tooltip
        content={`Sidebar: ${current.toLowerCase()} ([ flips it)`}
        side="right"
        render={
          <DropdownMenu.Trigger
            render={
              <button
                type="button"
                className="flex h-8.5 min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-[7px] text-sm text-kumo-subtle outline-none hover:bg-(--sidebar-active-bg) hover:text-kumo-default focus-visible:bg-(--sidebar-active-bg) group-data-[state=collapsed]/sidebar:flex-none"
                aria-label="Sidebar"
                data-testid="nav-mode"
              >
                <SidebarSimpleIcon size={16} className="shrink-0" />
                <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left group-data-[state=collapsed]/sidebar:hidden">
                  <span className="truncate">Sidebar</span>
                  <span className="ml-auto truncate text-[12px] text-kumo-inactive">{current}</span>
                </span>
              </button>
            }
          />
        }
      />
      <DropdownMenu.Content align="start" side="top" className="min-w-56">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Sidebar</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={navMode}
            onValueChange={(value) => setNavMode(value as NavMode)}
          >
            {NAV_MODES.map((mode) => (
              <DropdownMenu.RadioItem
                key={mode.value}
                value={mode.value}
                closeOnClick
                data-testid={`nav-mode-${mode.value}`}
              >
                <span className="flex flex-1 items-center gap-3">
                  <span className="grid gap-0.5">
                    <span>{mode.label}</span>
                    <span className="text-[12px] text-kumo-subtle">{mode.hint}</span>
                  </span>
                  <DropdownMenu.RadioItemIndicator className="text-kumo-brand" />
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
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
