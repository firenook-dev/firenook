import { CommandPalette as KumoCommandPalette } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, GaugeIcon, type Icon } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useConsoleUi } from '@/lib/store'
import { SECTIONS } from '@/lib/services'

interface Command {
  id: string
  title: string
  keywords: string
  icon: Icon
  run: () => void
}

export function CommandPalette() {
  const open = useConsoleUi((state) => state.paletteOpen)
  const setOpen = useConsoleUi((state) => state.setPaletteOpen)
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => {
      setOpen(false)
      void navigate({ to })
    }
    return [
      {
        id: 'overview',
        title: 'Overview',
        keywords: 'home status services',
        icon: GaugeIcon,
        run: go('/'),
      },
      ...SECTIONS.map((section) => ({
        id: section.to,
        title: section.label,
        keywords: section.services.join(' '),
        icon: section.icon,
        run: go(section.to),
      })),
      {
        id: 'legacy-ui',
        title: 'Open the Google Emulator UI',
        keywords: 'legacy official firebase',
        icon: ArrowSquareOutIcon,
        run: () => {
          setOpen(false)
          window.open('/', '_blank', 'noopener')
        },
      },
    ]
  }, [navigate, setOpen])

  const query = search.trim().toLowerCase()
  const items = query
    ? commands.filter((command) =>
        `${command.title} ${command.keywords}`.toLowerCase().includes(query),
      )
    : commands

  return (
    <KumoCommandPalette.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
      items={items}
      value={search}
      onValueChange={setSearch}
      itemToStringValue={(command) => command.title}
      onSelect={(command) => command.run()}
      getSelectableItems={(all) => all}
    >
      <KumoCommandPalette.Input placeholder="Jump to a section…" />
      <KumoCommandPalette.List>
        <KumoCommandPalette.Results>
          {(command: Command) => (
            <KumoCommandPalette.Item key={command.id} value={command} onClick={command.run}>
              <span className="flex items-center gap-3">
                <span className="h-lh flex items-center text-kumo-subtle">
                  <command.icon size={16} />
                </span>
                <span>{command.title}</span>
              </span>
            </KumoCommandPalette.Item>
          )}
        </KumoCommandPalette.Results>
        <KumoCommandPalette.Empty>Nothing matches</KumoCommandPalette.Empty>
      </KumoCommandPalette.List>
      <KumoCommandPalette.Footer>
        <span className="flex items-center gap-2">
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-[10px]">
            ↑↓
          </kbd>
          <span>Navigate</span>
        </span>
        <span className="flex items-center gap-2">
          <kbd className="rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 text-[10px]">
            ↵
          </kbd>
          <span>Open</span>
        </span>
      </KumoCommandPalette.Footer>
    </KumoCommandPalette.Root>
  )
}
