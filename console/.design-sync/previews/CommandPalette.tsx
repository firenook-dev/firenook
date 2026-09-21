import { CommandPalette } from '@firenook/kit'
import { DatabaseIcon, ScrollIcon, UsersIcon, type Icon } from '@phosphor-icons/react'
import { useState } from 'react'

interface Item {
  id: string
  title: string
  icon: Icon
}

const ITEMS: Item[] = [
  { id: 'firestore', title: 'Firestore', icon: DatabaseIcon },
  { id: 'auth', title: 'Authentication', icon: UsersIcon },
  { id: 'logs', title: 'Logs', icon: ScrollIcon },
]

/** Ctrl K anywhere: sections, paths, users and actions in one list. Shown open. */
export function Open() {
  const [search, setSearch] = useState('')
  return (
    <CommandPalette.Root
      open
      onOpenChange={() => {}}
      items={ITEMS}
      value={search}
      onValueChange={setSearch}
      itemToStringValue={(item) => item.title}
      onSelect={() => {}}
      getSelectableItems={(items) => items}
    >
      <CommandPalette.Input placeholder="Jump to a section, a path or a user…" />
      <CommandPalette.List>
        <CommandPalette.Results>
          {(item: Item) => (
            <CommandPalette.Item key={item.id} value={item} onClick={() => {}}>
              <span className="flex items-center gap-3">
                <span className="h-lh flex items-center text-kumo-subtle">
                  <item.icon size={16} />
                </span>
                <span>{item.title}</span>
              </span>
            </CommandPalette.Item>
          )}
        </CommandPalette.Results>
        <CommandPalette.Empty>Nothing matches</CommandPalette.Empty>
      </CommandPalette.List>
      <CommandPalette.Footer>
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
      </CommandPalette.Footer>
    </CommandPalette.Root>
  )
}
