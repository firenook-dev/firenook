// The `?` dialog: every key the page on screen answers to, read from the
// same registry the keys run through, so it cannot drift from what they do.
// Keys that do nothing right now (a `when()` that is false: no collection
// open, nothing ticked) are left out, so the list is what you can press.
//
// Loaded on first use; the shell mounts it once asked and keeps it mounted.

import { Button, Dialog, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { Kbd } from '@/components/kit'
import {
  SHELL_SCOPE,
  type ShortcutRegistration,
  describeKey,
  useShortcutRegistry,
} from '@/lib/shortcuts'

export interface ShortcutRow {
  label: string
  keys: readonly string[]
}

export interface ShortcutSection {
  heading: string
  /** The page the keys belong to, beside the heading. */
  detail?: string
  rows: readonly ShortcutRow[]
}

/**
 * The dialog's sections: the shell's keys first ("Everywhere"), then each
 * page scope in the order it mounted, a shortcut's `group` as a section of
 * its own. Shortcuts with the same label in one section share a row
 * (`↑ ↓`, `Delete ⌫`).
 */
export function shortcutSections(
  registrations: readonly ShortcutRegistration[],
): readonly ShortcutSection[] {
  const ordered = registrations.toSorted((a, b) => {
    const shell = Number(b.scope.id === SHELL_SCOPE) - Number(a.scope.id === SHELL_SCOPE)
    return shell !== 0 ? shell : a.order - b.order
  })
  const sections = new Map<
    string,
    { heading: string; detail: string | undefined; rows: Map<string, string[]> }
  >()
  for (const registration of ordered)
    for (const shortcut of registration.read()) {
      if (shortcut.when && !shortcut.when()) continue
      const shell = registration.scope.id === SHELL_SCOPE
      const heading = shortcut.group ?? (shell ? registration.scope.label : 'This page')
      const detail = shortcut.group || shell ? undefined : registration.scope.label
      const id = `${heading}\u0000${detail ?? ''}`
      let entry = sections.get(id)
      if (!entry) {
        entry = { heading, detail, rows: new Map() }
        sections.set(id, entry)
      }
      const keys = entry.rows.get(shortcut.label)
      if (keys) {
        if (!keys.includes(shortcut.key)) keys.push(shortcut.key)
      } else entry.rows.set(shortcut.label, [shortcut.key])
    }
  return Array.from(sections.values(), ({ heading, detail, rows }) => ({
    heading,
    ...(detail ? { detail } : {}),
    rows: Array.from(rows, ([label, keys]) => ({ label, keys })),
  }))
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const registrations = useShortcutRegistry((state) => state.registrations)
  const sections = open ? shortcutSections(registrations) : []
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {/* `lg` is 32rem, 448 px at the console's 14 px root: room for a label
          and its keys on one line. */}
      <Dialog size="lg" className="flex max-h-[min(640px,85vh)] flex-col p-0">
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6 pb-3">
          <Dialog.Title className="text-lg font-semibold">Keyboard shortcuts</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
          />
        </div>
        <div className="min-h-0 overflow-y-auto px-6" data-testid="shortcuts">
          {sections.map((section) => (
            <section
              key={`${section.heading}\u0000${section.detail ?? ''}`}
              aria-label={
                section.detail ? `${section.heading} · ${section.detail}` : section.heading
              }
              className="mb-4 last:mb-2"
            >
              <h3 className="mb-1 text-[12px] font-semibold text-kumo-subtle">
                {section.heading}
                {section.detail && <span className="font-normal"> · {section.detail}</span>}
              </h3>
              <ul className="grid">
                {section.rows.map((row) => (
                  <li
                    key={row.label}
                    className="flex min-h-8 items-center justify-between gap-4 border-b border-kumo-hairline py-1 last:border-b-0"
                    data-testid="shortcut-row"
                  >
                    <span className="min-w-0 text-[14px] text-kumo-default">{row.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {row.keys.map((key) => (
                        <Kbd key={key} className="font-sans text-kumo-default">
                          {describeKey(key)}
                        </Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <Dialog.Description className="shrink-0 border-t border-kumo-line px-6 py-3">
          <Text variant="secondary" size="sm" as="span">
            Single keys wait while you type in a field or edit a value.
          </Text>
        </Dialog.Description>
      </Dialog>
    </Dialog.Root>
  )
}
