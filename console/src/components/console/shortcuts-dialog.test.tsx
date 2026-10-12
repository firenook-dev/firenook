import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Shortcut, type ShortcutRegistration, useShortcuts } from '@/lib/shortcuts'
import { ShortcutsDialog, shortcutSections } from './shortcuts-dialog'

const noop = () => {}

function registration(
  order: number,
  id: string,
  label: string,
  shortcuts: readonly Shortcut[],
): ShortcutRegistration {
  return { order, scope: { id, label }, read: () => shortcuts, signature: '' }
}

describe('what the dialog lists', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' })
  })

  it('puts the shell first, then each page in the order it mounted, groups as their own sections', () => {
    const sections = shortcutSections([
      registration(9, 'firestore', 'Firestore', [
        { key: 'ArrowUp', label: 'Move between rows', group: 'Grid', run: noop },
        { key: 'ArrowDown', label: 'Move between rows', group: 'Grid', run: noop },
      ]),
      registration(7, 'firestore', 'Firestore', [
        { key: 'f', label: 'Filter the documents', run: noop },
        { key: 'Delete', label: 'Delete the ticked documents', run: noop },
        { key: 'Backspace', label: 'Delete the ticked documents', run: noop },
      ]),
      registration(1, 'shell', 'Everywhere', [
        { key: 'Mod+k', label: 'Search the console', run: noop },
        { key: '?', label: 'Keyboard shortcuts', run: noop },
      ]),
    ])
    expect(sections).toEqual([
      {
        heading: 'Everywhere',
        rows: [
          { label: 'Search the console', keys: ['Mod+k'] },
          { label: 'Keyboard shortcuts', keys: ['?'] },
        ],
      },
      {
        heading: 'This page',
        detail: 'Firestore',
        rows: [
          { label: 'Filter the documents', keys: ['f'] },
          { label: 'Delete the ticked documents', keys: ['Delete', 'Backspace'] },
        ],
      },
      { heading: 'Grid', rows: [{ label: 'Move between rows', keys: ['ArrowUp', 'ArrowDown'] }] },
    ])
  })

  it('leaves out what does nothing right now', () => {
    const sections = shortcutSections([
      registration(2, 'firestore', 'Firestore', [
        { key: 'n', label: 'New document', run: noop, when: () => false },
        { key: 'f', label: 'Filter the documents', run: noop, when: () => true },
      ]),
    ])
    expect(sections).toEqual([
      {
        heading: 'This page',
        detail: 'Firestore',
        rows: [{ label: 'Filter the documents', keys: ['f'] }],
      },
    ])
  })
})

describe('the dialog', () => {
  afterEach(cleanup)

  it('shows the mounted keys with the keys written for this platform', () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' })
    renderHook(() => {
      useShortcuts({ id: 'shell', label: 'Everywhere' }, [
        { key: 'Mod+k', label: 'Search the console', run: noop, allowInInputs: true },
      ])
      useShortcuts({ id: 'firestore.rules', label: 'Security rules' }, [
        { key: 'Mod+Enter', label: 'Apply the draft', run: noop, allowInInputs: true },
      ])
    })
    render(<ShortcutsDialog open onOpenChange={noop} />)
    const list = screen.getByTestId('shortcuts')
    const everywhere = within(list).getByRole('region', { name: 'Everywhere' })
    expect(within(everywhere).getByText('Search the console')).toBeInTheDocument()
    expect(within(everywhere).getByText('Ctrl+K')).toBeInTheDocument()
    const page = within(list).getByRole('region', { name: 'This page · Security rules' })
    expect(within(page).getByText('Ctrl+↵')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  it('follows scopes as pages mount and unmount while it is open', () => {
    render(<ShortcutsDialog open onOpenChange={noop} />)
    expect(screen.queryAllByTestId('shortcut-row')).toHaveLength(0)
    const page = renderHook(() =>
      useShortcuts({ id: 'auth', label: 'Authentication' }, [
        { key: 'n', label: 'New user', run: noop },
      ]),
    )
    expect(screen.getByText('New user')).toBeInTheDocument()
    act(() => page.unmount())
    expect(screen.queryByText('New user')).toBeNull()
  })
})
