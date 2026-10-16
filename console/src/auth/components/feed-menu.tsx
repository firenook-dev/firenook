// A feed row's menu, the way `DataTable` gives a table row its own: one
// `RowMenuPopup` for the whole list, opened four ways with the same items in
// the same order — a right-click on the row, the row's ⋯ button, Shift+F10
// or the ContextMenu key on the selected row, and ⌘K while a row is
// selected (`useRowMenuPalette`). The Inbox and Activity lists use it.

import { Button } from '@cloudflare/kumo'
import { DotsThreeIcon } from '@phosphor-icons/react'
import { type MouseEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import {
  type RowMenuAnchor,
  type RowMenuItem,
  RowMenuPopup,
  useRowMenuPalette,
} from '@/components/console/row-menu'
import { type FeedStore, useFeed } from '@/lib/live/feed-store'
import { useShortcuts } from '@/lib/shortcuts'

/** What a row asks of its list, through a ref so no row re-renders for it. */
export interface FeedMenuHandle {
  /** Opens the row's menu at the pointer or beside an element. */
  open: (key: string, anchor: RowMenuAnchor) => void
  /** A pointer went down on the row: the selection that follows is a click, not a key. */
  press: (key: string) => void
}

/** The item a store holds under `key`, if it still holds it. */
export function itemOf<T>(store: FeedStore<T>, key: string | undefined): T | undefined {
  if (key === undefined) return undefined
  const row = store.at(store.indexOf(key))
  return row?.kind === 'item' ? row.item : undefined
}

/**
 * The item a store holds under `key`, kept current as rows arrive and change
 * (a message marked used, a call's row replaced): what an open reader shows.
 */
export function useFeedItem<T>(store: FeedStore<T>, key: string | undefined): T | undefined {
  // A read of the mutable store while rendering: see `useFeedMenu`.
  'use no memo'
  useFeed(store)
  return itemOf(store, key)
}

/**
 * The rows beside `key` in a newest-first list: `newer` is the one above it
 * (the reader's "previous"), `older` the one below. Gaps and markers are
 * stepped over.
 */
export function useFeedNeighbours<T>(
  store: FeedStore<T>,
  key: string | undefined,
): { newer: T | undefined; older: T | undefined } {
  // A read of the mutable store while rendering: see `useFeedMenu`.
  'use no memo'
  useFeed(store)
  const at = key === undefined ? -1 : store.indexOf(key)
  if (at === -1) return { newer: undefined, older: undefined }
  const find = (step: 1 | -1): T | undefined => {
    for (let index = at + step; index >= 0 && index < store.size(); index += step) {
      const row = store.at(index)
      if (row?.kind === 'item') return row.item
    }
    return undefined
  }
  // The store holds the newest last.
  return { newer: find(1), older: find(-1) }
}

export function useFeedMenu<T>({
  store,
  items,
  selectedKey,
  subject,
  scope,
  testId,
  onPress,
}: {
  store: FeedStore<T>
  /** The row's items, in menu order (destructive ones go last by themselves). */
  items: (item: T) => readonly RowMenuItem[]
  /** The list's selected row: Shift+F10 and ⌘K act on it. */
  selectedKey: string | undefined
  /** What the selected row is called in ⌘K's group heading. */
  subject: (item: T) => string
  /** The shortcut scope's id and the list's test id (where its rows are found). */
  scope: string
  testId: string
  /** A pointer went down on a row (before the list selects it). */
  onPress?: ((key: string) => void) | undefined
}): { handle: { readonly current: FeedMenuHandle }; popup: ReactNode } {
  // It reads the store's rows while rendering (the selected row, the row the
  // menu is open on), and the store is mutable: the compiler would keep such
  // a read for as long as the store is the same object.
  'use no memo'
  useFeed(store)
  const [menu, setMenu] = useState<{ key: string; anchor: RowMenuAnchor } | null>(null)
  const handle = useRef<FeedMenuHandle>({ open: () => undefined, press: () => undefined })
  useLayoutEffect(() => {
    handle.current = {
      open: (key, anchor) => setMenu({ key, anchor }),
      press: (key) => onPress?.(key),
    }
  })

  const selected = itemOf(store, selectedKey)
  // Built once per selected row, not per frame of new rows, so ⌘K is not
  // told again on every frame.
  const [cache, setCache] = useState<{
    item: T | undefined
    items: readonly RowMenuItem[] | undefined
  }>({ item: undefined, items: undefined })
  let current = cache
  if (cache.item !== selected) {
    current = { item: selected, items: selected === undefined ? undefined : items(selected) }
    setCache(current)
  }
  useRowMenuPalette(current.items, selected === undefined ? undefined : subject(selected))

  const openSelected = () => {
    if (selectedKey === undefined) return
    const row = document.querySelector<HTMLElement>(
      `[data-testid="${testId}"] [data-testid="feed-row"][data-key="${CSS.escape(selectedKey)}"]`,
    )
    const button = row?.querySelector<HTMLElement>('[data-row-menu]')
    const anchor = button ?? row
    if (anchor) setMenu({ key: selectedKey, anchor })
  }
  const hasSelection = () => itemOf(store, selectedKey) !== undefined
  useShortcuts({ id: `${scope}.row-menu`, label: 'Row' }, [
    {
      key: 'Shift+F10',
      label: 'The row’s menu',
      group: 'Feed',
      when: hasSelection,
      run: openSelected,
    },
    {
      key: 'ContextMenu',
      label: 'The row’s menu',
      group: 'Feed',
      when: hasSelection,
      run: openSelected,
    },
  ])

  const open = menu === null ? undefined : itemOf(store, menu.key)
  const popup = (
    <RowMenuPopup
      items={open === undefined ? [] : items(open)}
      open={menu !== null && open !== undefined}
      onOpenChange={(next) => {
        if (!next) setMenu(null)
      }}
      anchor={menu?.anchor ?? null}
    />
  )
  return { handle, popup }
}

/**
 * A row's frame for its menu: a right-click opens it at the pointer, and the
 * ⋯ button at the row's end (shown on hover and on the selected row) opens it
 * beside itself.
 */
export function FeedMenuRow({
  rowKey,
  label,
  handle,
  children,
}: {
  rowKey: string
  /** The button's accessible name: "Actions for +15550100". */
  label: string
  handle: { readonly current: FeedMenuHandle }
  children: ReactNode
}) {
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    handle.current.open(rowKey, { x: event.clientX, y: event.clientY })
  }
  return (
    <div
      // A container, so a row's columns give way by the list's width, not the window's.
      className="group/row @container flex h-full min-w-0 flex-1 items-center"
      onContextMenu={onContextMenu}
      onPointerDown={() => handle.current.press(rowKey)}
    >
      {children}
      <span className="flex shrink-0 items-center pr-1">
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<DotsThreeIcon weight="bold" />}
          aria-label={label}
          aria-haspopup="menu"
          tabIndex={-1}
          data-testid="row-menu-button"
          data-row-menu=""
          onClick={(event) => {
            event.stopPropagation()
            handle.current.open(rowKey, event.currentTarget)
          }}
          // Shown on the selected row too: the feed marks it `aria-selected`.
          className="shrink-0 !text-kumo-subtle opacity-0 group-hover/row:opacity-100 in-aria-selected:opacity-100 hover:!text-kumo-default focus-visible:opacity-100"
        />
      </span>
    </div>
  )
}
