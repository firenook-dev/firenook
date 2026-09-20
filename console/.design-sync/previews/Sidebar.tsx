import { Sidebar, Text, TooltipProvider } from '@firenook/kit'
import { DatabaseIcon, GaugeIcon, HouseIcon, ScrollIcon, UsersIcon } from '@phosphor-icons/react'

function Nav() {
  return (
    <Sidebar>
      <Sidebar.Header>
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="flex size-6 items-center justify-center rounded-md bg-kumo-brand text-white">
            <GaugeIcon size={14} weight="bold" />
          </span>
          <span className="group-data-[state=collapsed]/sidebar:hidden">
            <Text bold>Firenook</Text>
          </span>
        </div>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.Menu>
            <Sidebar.MenuButton icon={HouseIcon} tooltip="Overview">
              Overview
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Data</Sidebar.GroupLabel>
          <Sidebar.Menu>
            <Sidebar.MenuButton icon={DatabaseIcon} tooltip="Firestore" active>
              Firestore
            </Sidebar.MenuButton>
            <Sidebar.MenuButton icon={UsersIcon} tooltip="Authentication">
              Authentication
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Observe</Sidebar.GroupLabel>
          <Sidebar.Menu>
            <Sidebar.MenuButton icon={ScrollIcon} tooltip="Logs">
              Logs
            </Sidebar.MenuButton>
          </Sidebar.Menu>
        </Sidebar.Group>
      </Sidebar.Content>
      <Sidebar.Footer>
        <Sidebar.Trigger />
      </Sidebar.Footer>
    </Sidebar>
  )
}

/** Groups by area; the active item is filled. Use `contained` when the sidebar lives inside a bounded panel. */
export function Expanded() {
  return (
    <TooltipProvider>
      <div className="h-[420px] w-72 overflow-hidden rounded-lg ring ring-kumo-hairline">
        <Sidebar.Provider contained defaultOpen mobileBreakpoint={0} className="h-full min-h-0!">
          <Nav />
          <div className="flex-1 bg-kumo-canvas" />
        </Sidebar.Provider>
      </div>
    </TooltipProvider>
  )
}

export function Collapsed() {
  return (
    <TooltipProvider>
      <div className="h-[420px] w-40 overflow-hidden rounded-lg ring ring-kumo-hairline">
        <Sidebar.Provider
          contained
          defaultOpen={false}
          mobileBreakpoint={0}
          className="h-full min-h-0!"
        >
          <Nav />
          <div className="flex-1 bg-kumo-canvas" />
        </Sidebar.Provider>
      </div>
    </TooltipProvider>
  )
}
