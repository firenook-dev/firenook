import {
  Badge,
  Button,
  InlineCopyText,
  Sidebar,
  Text,
  Toasty,
  TooltipProvider,
} from '@cloudflare/kumo'
import { CommandIcon, GaugeIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { statusQuery } from '@/api/queries'
import { useConsoleUi } from '@/lib/store'
import { AREA_LABELS, SECTIONS, type ServiceArea } from '@/lib/services'
import { CommandPalette } from './command-palette'

const AREAS: readonly ServiceArea[] = ['data', 'compute', 'messaging', 'observe']

export function AppShell({ children }: { children: ReactNode }) {
  const togglePalette = useConsoleUi((state) => state.togglePalette)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        togglePalette()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePalette])

  return (
    <Toasty>
      <TooltipProvider>
        <Sidebar.Provider defaultOpen className="h-full">
          <Navigation />
          <div className="flex min-w-0 flex-1 flex-col bg-kumo-canvas">
            <TopBar />
            <main className="min-h-0 flex-1 overflow-auto px-6 py-5">{children}</main>
          </div>
        </Sidebar.Provider>
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
    <Sidebar>
      <Sidebar.Header>
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="flex size-6 items-center justify-center rounded-md bg-kumo-brand text-kumo-inverse">
            <GaugeIcon size={14} weight="bold" />
          </span>
          <Text bold>Firenook</Text>
          <Text variant="secondary">console</Text>
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
        <Sidebar.Trigger />
      </Sidebar.Footer>
    </Sidebar>
  )
}

function TopBar() {
  const status = useQuery(statusQuery)
  const setPaletteOpen = useConsoleUi((state) => state.setPaletteOpen)
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
