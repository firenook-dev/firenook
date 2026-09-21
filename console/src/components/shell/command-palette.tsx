import { CommandPalette as KumoCommandPalette } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, GaugeIcon } from '@phosphor-icons/react'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { useConsoleUi } from '@/lib/store'
import { SECTIONS } from '@/lib/services'

export function CommandPalette() {
  const open = useConsoleUi((state) => state.paletteOpen)
  const setOpen = useConsoleUi((state) => state.setPaletteOpen)
  const providers = usePaletteProviders((state) => state.providers)
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const sections = useMemo<PaletteItem[]>(() => {
    const go = (to: string) => () => void navigate({ to })
    return [
      {
        id: 'overview',
        title: 'Overview',
        keywords: 'home status services',
        icon: <GaugeIcon size={16} />,
        run: go('/'),
      },
      ...SECTIONS.map((section) => ({
        id: section.to,
        title: section.label,
        keywords: section.services.join(' '),
        icon: <section.icon size={16} />,
        run: go(section.to),
      })),
      {
        id: 'legacy-ui',
        title: 'Open the Google Emulator UI',
        keywords: 'legacy official firebase',
        icon: <ArrowSquareOutIcon size={16} />,
        run: () => window.open('/', '_blank', 'noopener'),
      },
    ]
  }, [navigate])

  // What the page on screen contributes comes first; the sections always follow.
  const groups = useMemo<PaletteGroup[]>(() => {
    const contributed = Object.values(providers).flatMap((provider) => provider(search))
    const matching = sections.filter((item) => matchesQuery(item, search))
    return [...contributed, { label: 'Sections', items: matching }].filter(
      (group) => group.items.length > 0,
    )
  }, [providers, search, sections])

  const choose = (item: PaletteItem) => {
    setOpen(false)
    setSearch('')
    item.run()
  }

  return (
    <KumoCommandPalette.Root<PaletteGroup, PaletteItem>
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
      items={groups}
      value={search}
      onValueChange={setSearch}
      itemToStringValue={(group) => group.label}
      onSelect={choose}
      getSelectableItems={(all) => all.flatMap((group) => group.items)}
    >
      <KumoCommandPalette.Input placeholder="Jump anywhere…" data-testid="palette-input" />
      <KumoCommandPalette.List>
        <KumoCommandPalette.Results>
          {(group: PaletteGroup) => (
            <KumoCommandPalette.Group key={group.label} items={group.items}>
              <KumoCommandPalette.GroupLabel>{group.label}</KumoCommandPalette.GroupLabel>
              <KumoCommandPalette.Items>
                {(item: PaletteItem) => (
                  <KumoCommandPalette.ResultItem
                    key={item.id}
                    title={item.title}
                    {...(item.breadcrumbs ? { breadcrumbs: item.breadcrumbs } : {})}
                    {...(item.description ? { description: item.description } : {})}
                    icon={item.icon}
                    value={item}
                    onClick={() => choose(item)}
                  />
                )}
              </KumoCommandPalette.Items>
            </KumoCommandPalette.Group>
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
