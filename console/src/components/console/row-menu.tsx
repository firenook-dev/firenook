// One menu per row, reached four ways — right-click, Shift+F10 or the
// ContextMenu key on the cursor row, the row's ⋯ button, and ⌘K while the
// row is the cursor — with the same items in the same order every time. A
// destructive item goes last, after a separator, in red; one that cannot run
// now stays listed, dimmed, with the reason in its tooltip, so the menu never
// changes shape under the pointer.
//
// All of them are Kumo's `DropdownMenu` (Base UI's Menu): the ⋯ button is its
// trigger, and a right-click or a key opens the same popup anchored to the
// pointer or the row, so there is one look and one keyboard model.

import { Button, DropdownMenu, Tooltip, cn } from '@cloudflare/kumo'
import { DotsThreeIcon, type Icon, ListIcon } from '@phosphor-icons/react'
import { type MouseEvent, type ReactNode, useEffect, useState } from 'react'
import { Kbd } from '@/components/kit'
import { type PaletteGroup, matchesQuery, usePaletteProviders } from '@/lib/palette'
import { describeKey } from '@/lib/shortcuts'

export interface RowMenuItem {
  id: string
  label: string
  icon?: Icon | undefined
  /** A key that does the same from the row: `'Delete'`, `'Mod+c'`. */
  shortcut?: string | undefined
  /** Listed last, after a separator, in red. */
  danger?: boolean | undefined
  /** Why it cannot run now; shown as the tooltip of the dimmed item. */
  disabled?: string | undefined
  run: () => void
}

/** The items in menu order: the rest as given, then the destructive ones. */
export function menuOrder(items: readonly RowMenuItem[]): {
  safe: RowMenuItem[]
  danger: RowMenuItem[]
} {
  return {
    safe: items.filter((item) => !item.danger),
    danger: items.filter((item) => item.danger),
  }
}

/** Where a menu opened without its ⋯ trigger hangs: an element, or a point (a right-click). */
export type RowMenuAnchor = Element | { x: number; y: number }

function virtualAnchor(anchor: RowMenuAnchor) {
  if (anchor instanceof Element) return anchor
  return {
    getBoundingClientRect: () =>
      DOMRect.fromRect({ x: anchor.x, y: anchor.y, width: 0, height: 0 }),
  }
}

function MenuItems({ items }: { items: readonly RowMenuItem[] }) {
  const { safe, danger } = menuOrder(items)
  return (
    <>
      {safe.map((item) => (
        <Item key={item.id} item={item} />
      ))}
      {safe.length > 0 && danger.length > 0 && <DropdownMenu.Separator />}
      {danger.map((item) => (
        <Item key={item.id} item={item} />
      ))}
    </>
  )
}

function Item({ item }: { item: RowMenuItem }) {
  const row = (
    <DropdownMenu.Item
      icon={item.icon}
      variant={item.danger ? 'danger' : 'default'}
      disabled={item.disabled !== undefined}
      onClick={() => item.run()}
      className="gap-0"
      data-testid={`row-menu-${item.id}`}
    >
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.shortcut && (
        <span className="ml-4 shrink-0">
          <Kbd>{describeKey(item.shortcut)}</Kbd>
        </span>
      )}
    </DropdownMenu.Item>
  )
  if (item.disabled === undefined) return row
  // A disabled item takes no pointer, so the reason hangs off a wrapper.
  return (
    <Tooltip content={item.disabled} side="right" render={<span className="block">{row}</span>} />
  )
}

/**
 * The menu without its trigger, opened by its owner at a point or beside an
 * element: the right-click and the keyboard. `DataTable` keeps one of these
 * for all its rows.
 */
export function RowMenuPopup({
  items,
  open,
  onOpenChange,
  anchor,
  testId = 'row-menu',
}: {
  items: readonly RowMenuItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: RowMenuAnchor | null
  testId?: string
}) {
  return (
    <DropdownMenu open={open && anchor !== null && items.length > 0} onOpenChange={onOpenChange}>
      <DropdownMenu.Content
        anchor={anchor ? virtualAnchor(anchor) : null}
        align="start"
        sideOffset={anchor instanceof Element ? 4 : 0}
        // Opened from a key or a right-click, the popup itself takes focus
        // until an item is highlighted; the browser's outline round the
        // whole menu would say nothing the menu does not.
        className="outline-none"
      >
        <div data-testid={testId}>
          <MenuItems items={items} />
        </div>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/**
 * Wraps a row so a right-click opens its menu at the pointer. For a `<tr>`,
 * `DataTable` handles the right-click itself; this is for rows built of
 * other elements (a tree, a feed line).
 */
export function RowMenu({
  items,
  children,
}: {
  items: readonly RowMenuItem[]
  children: ReactNode
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const onContextMenu = (event: MouseEvent) => {
    if (items.length === 0) return
    event.preventDefault()
    setAt({ x: event.clientX, y: event.clientY })
  }
  return (
    <div className="contents" onContextMenu={onContextMenu}>
      {children}
      <RowMenuPopup
        items={items}
        open={at !== null}
        onOpenChange={(open) => {
          if (!open) setAt(null)
        }}
        anchor={at}
      />
    </div>
  )
}

/** The row's ⋯ button: the same menu, from a visible control. */
export function RowMenuButton({
  items,
  label,
  open,
  onOpenChange,
  className,
  testId = 'row-menu-button',
}: {
  items: readonly RowMenuItem[]
  /** Its accessible name: "Actions for u_9f3k2". */
  label: string
  /** Controlled by an owner that also opens it from the keyboard (Shift+F10). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  testId?: string
}) {
  return (
    <DropdownMenu
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={<DotsThreeIcon weight="bold" />}
            aria-label={label}
            className={cn('shrink-0 !text-kumo-subtle hover:!text-kumo-default', className)}
            data-testid={testId}
            onClick={(event) => event.stopPropagation()}
          />
        }
      />
      {/* Opened from the keyboard, the popup takes focus until an item is
          highlighted; an outline round the whole menu says nothing. */}
      <DropdownMenu.Content align="end" className="outline-none">
        <div data-testid="row-menu">
          <MenuItems items={items} />
        </div>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/** The row menu's items as ⌘K rows, under the row's name: what is enabled now, in menu order. */
export function rowMenuGroups(
  items: readonly RowMenuItem[],
  subject: string,
  query: string,
): PaletteGroup[] {
  const { safe, danger } = menuOrder(items)
  const rows = [...safe, ...danger]
    .filter((item) => item.disabled === undefined)
    .map((item) => {
      const Glyph = item.icon ?? ListIcon
      return {
        id: `row-menu:${item.id}`,
        title: item.label,
        keywords: subject,
        icon: <Glyph size={16} />,
        run: item.run,
      }
    })
    .filter((row) => matchesQuery(row, query))
  return rows.length > 0 ? [{ label: subject, items: rows }] : []
}

/**
 * Offers the cursor row's menu in ⌘K while there is one: "u_9f3k2 ›
 * Disable…". `subject` names the row, and is the group's heading.
 */
export function useRowMenuPalette(
  items: readonly RowMenuItem[] | undefined,
  subject = 'This row',
): void {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  useEffect(() => {
    if (!items || items.length === 0) return undefined
    register('row-menu', (query) => rowMenuGroups(items, subject, query))
    return () => unregister('row-menu')
  }, [items, subject, register, unregister])
}
