import { act, cleanup, render, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type Shortcut,
  type ShortcutScope,
  describeKey,
  dispatchShortcut,
  isSingleKey,
  isTyping,
  matchesKey,
  useEditing,
  useShortcutListener,
  useShortcutRegistry,
  useShortcuts,
} from './shortcuts'

function setPlatform(platform: string, hint?: string) {
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => platform })
  Object.defineProperty(navigator, 'userAgentData', {
    configurable: true,
    get: () => (hint ? { platform: hint } : undefined),
  })
}

/** A key press on `target` (the document body unless given), as the browser sends it. */
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

/** Mounts one scope; returns its unmount. */
function mount(scope: ShortcutScope, shortcuts: readonly Shortcut[]) {
  const hook = renderHook(() => useShortcuts(scope, shortcuts))
  return hook.unmount
}

describe('the keyboard registry', () => {
  beforeEach(() => {
    setPlatform('MacIntel')
    renderHook(() => useShortcutListener())
  })
  afterEach(() => {
    cleanup()
    act(() => {
      while (useEditing.getState().editing) useEditing.getState().setEditing(false)
    })
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('gives a key to the most recently mounted scope', () => {
    const shell = vi.fn()
    const page = vi.fn()
    mount({ id: 'shell', label: 'Everywhere' }, [{ key: 'n', label: 'Shell n', run: shell }])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unmountPage = mount({ id: 'page', label: 'Page' }, [
      { key: 'n', label: 'New', run: page },
    ])
    const event = press('n')
    expect(page).toHaveBeenCalledTimes(1)
    expect(shell).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    unmountPage()
    press('n')
    expect(shell).toHaveBeenCalledTimes(1)
  })

  it('ranks a scope by when it first rendered, so a page outranks the shell around it', () => {
    const shell = vi.fn()
    const page = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    function Page() {
      useShortcuts({ id: 'page', label: 'Page' }, [{ key: 'x', label: 'Page x', run: page }])
      return null
    }
    function Shell() {
      useShortcuts({ id: 'shell', label: 'Everywhere' }, [
        { key: 'x', label: 'Shell x', run: shell },
      ])
      return createElement(Page)
    }
    // Effects run children first, so the page registers before the shell;
    // the page still wins because it rendered after it.
    render(createElement(Shell))
    press('x')
    expect(page).toHaveBeenCalledTimes(1)
    expect(shell).not.toHaveBeenCalled()
  })

  it('skips a shortcut whose when() is false, and the key falls through', () => {
    const shell = vi.fn()
    const page = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount({ id: 'shell', label: 'Everywhere' }, [{ key: 't', label: 'Panel', run: shell }])
    let ready = false
    mount({ id: 'page', label: 'Page' }, [
      { key: 't', label: 'Page t', run: page, when: () => ready },
    ])
    press('t')
    expect(shell).toHaveBeenCalledTimes(1)
    ready = true
    press('t')
    expect(page).toHaveBeenCalledTimes(1)
  })

  it('leaves keys to a field, unless the shortcut allows inputs', () => {
    const single = vi.fn()
    const palette = vi.fn()
    mount({ id: 'page', label: 'Page' }, [
      { key: 'f', label: 'Filter', run: single },
      { key: 'Mod+k', label: 'Search', run: palette, allowInInputs: true },
    ])
    const input = document.body.appendChild(document.createElement('input'))
    const area = document.body.appendChild(document.createElement('textarea'))
    const editable = document.body.appendChild(document.createElement('div'))
    editable.setAttribute('contenteditable', 'true')
    const inner = editable.appendChild(document.createElement('span'))
    for (const target of [input, area, editable, inner]) {
      const event = press('f', {}, target)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(single).not.toHaveBeenCalled()
    press('k', { metaKey: true }, input)
    expect(palette).toHaveBeenCalledTimes(1)

    const checkbox = document.body.appendChild(document.createElement('input'))
    checkbox.type = 'checkbox'
    press('f', {}, checkbox)
    expect(single).toHaveBeenCalledTimes(1)
  })

  it('lets an overlay keep its single keys, and only modified keys that allow inputs reach the page', () => {
    const escape = vi.fn()
    const palette = vi.fn()
    mount({ id: 'page', label: 'Page' }, [
      { key: 'Escape', label: 'Close', run: escape, allowInInputs: true },
      { key: 'Mod+k', label: 'Search', run: palette, allowInInputs: true },
    ])
    for (const role of ['dialog', 'menu', 'listbox', 'alertdialog']) {
      const overlay = document.body.appendChild(document.createElement('div'))
      overlay.setAttribute('role', role)
      const button = overlay.appendChild(document.createElement('button'))
      press('Escape', {}, button)
      press('k', { metaKey: true }, button)
    }
    expect(escape).not.toHaveBeenCalled()
    expect(palette).toHaveBeenCalledTimes(4)
  })

  it('gives the page its single keys while an overlay plays its exit, focus still on it', () => {
    const tick = vi.fn()
    mount({ id: 'page', label: 'Page' }, [{ key: 'Space', label: 'Tick', run: tick }])
    const menu = document.body.appendChild(document.createElement('div'))
    menu.setAttribute('role', 'menu')
    const item = menu.appendChild(document.createElement('button'))
    press(' ', {}, item)
    expect(tick).not.toHaveBeenCalled()
    // Escape shut it: Base UI marks it closed while it fades.
    menu.setAttribute('data-closed', '')
    press(' ', {}, item)
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('holds single keys back while a value is being edited, and lets modified keys through', () => {
    const single = vi.fn()
    const save = vi.fn()
    mount({ id: 'page', label: 'Page' }, [
      { key: 'e', label: 'Explain', run: single },
      { key: 'Shift+C', label: 'Copy as JSON', run: single },
      { key: 'Mod+s', label: 'Save', run: save },
    ])
    act(() => useEditing.getState().setEditing(true))
    press('e')
    press('C', { shiftKey: true })
    press('s', { metaKey: true })
    expect(single).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
    act(() => useEditing.getState().setEditing(false))
    press('e')
    expect(single).toHaveBeenCalledTimes(1)
  })

  it('stays editing while any editor is open', () => {
    const { setEditing } = useEditing.getState()
    act(() => {
      setEditing(true)
      setEditing(true)
      setEditing(false)
    })
    expect(useEditing.getState().editing).toBe(true)
    act(() => {
      setEditing(false)
      setEditing(false)
    })
    expect(useEditing.getState().editing).toBe(false)
    act(() => setEditing(true))
    expect(useEditing.getState().editing).toBe(true)
  })

  it('warns in development when two mounted scopes bind the same key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount({ id: 'a', label: 'Logs' }, [{ key: 'e', label: 'Errors only', run: () => {} }])
    expect(warn).not.toHaveBeenCalled()
    mount({ id: 'b', label: 'Firestore' }, [{ key: 'e', label: 'Explain', run: () => {} }])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('"Logs" and "Firestore"')
    mount({ id: 'c', label: 'Other' }, [{ key: 'Mod+e', label: 'Something else', run: () => {} }])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('takes the machine from navigator.platform over a user-agent hint that poses as another', () => {
    const run = vi.fn()
    mount({ id: 'page', label: 'Page' }, [{ key: 'Mod+k', label: 'Search', run }])
    setPlatform('MacIntel', 'Windows')
    press('k', { metaKey: true })
    expect(run).toHaveBeenCalledTimes(1)
    setPlatform('', 'macOS')
    press('k', { metaKey: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reads Mod as ⌘ on macOS and Ctrl elsewhere', () => {
    const run = vi.fn()
    mount({ id: 'page', label: 'Page' }, [{ key: 'Mod+Enter', label: 'Apply', run }])
    press('Enter', { ctrlKey: true })
    expect(run).not.toHaveBeenCalled()
    press('Enter', { metaKey: true })
    expect(run).toHaveBeenCalledTimes(1)
    setPlatform('Win32')
    press('Enter', { metaKey: true })
    expect(run).toHaveBeenCalledTimes(1)
    press('Enter', { ctrlKey: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('lets Home, End, PgUp, PgDn and Shift+F10 reach a table scope', () => {
    const heard: string[] = []
    const keys = ['Home', 'End', 'PageUp', 'PageDown', 'Shift+F10', 'ContextMenu', 'Space']
    mount(
      { id: 'table', label: 'Users' },
      keys.map((key) => ({ key, label: key, group: 'Table', run: () => heard.push(key) })),
    )
    press('Home')
    press('End')
    press('PageUp')
    press('PageDown')
    press('F10')
    press('F10', { shiftKey: true })
    press('ContextMenu')
    press(' ')
    expect(heard).toEqual([
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Shift+F10',
      'ContextMenu',
      'Space',
    ])
  })

  it('forgets a scope when it unmounts', () => {
    const run = vi.fn()
    const unmount = mount({ id: 'page', label: 'Page' }, [{ key: 'g', label: 'Group', run }])
    expect(useShortcutRegistry.getState().registrations).toHaveLength(1)
    unmount()
    expect(useShortcutRegistry.getState().registrations).toHaveLength(0)
    expect(press('g').defaultPrevented).toBe(false)
  })

  it('runs the newest handler without registering again on every render', () => {
    const calls: number[] = []
    const { rerender } = renderHook(
      ({ count }) =>
        useShortcuts({ id: 'grid', label: 'Grid' }, [
          { key: 'ArrowDown', label: 'Move', run: () => calls.push(count) },
        ]),
      { initialProps: { count: 1 } },
    )
    const registered = useShortcutRegistry.getState().registrations
    rerender({ count: 2 })
    rerender({ count: 3 })
    expect(useShortcutRegistry.getState().registrations).toBe(registered)
    press('ArrowDown')
    expect(calls).toEqual([3])
  })

  it('ignores a key that is part of an IME composition', () => {
    const run = vi.fn()
    mount({ id: 'page', label: 'Page' }, [{ key: 'n', label: 'New', run }])
    expect(dispatchShortcut(new KeyboardEvent('keydown', { key: 'n', isComposing: true }))).toBe(
      false,
    )
    expect(run).not.toHaveBeenCalled()
  })
})

/** A key press that goes nowhere, for matching alone. */
const event = (key: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key, ...init })

describe('matching a key', () => {
  beforeEach(() => setPlatform('MacIntel'))

  it('needs exactly the modifiers the shortcut names', () => {
    expect(matchesKey(event('n'), 'n')).toBe(true)
    expect(matchesKey(event('n', { metaKey: true }), 'n')).toBe(false)
    expect(matchesKey(event('n', { altKey: true }), 'n')).toBe(false)
    expect(matchesKey(event('N', { shiftKey: true }), 'n')).toBe(false)
    expect(matchesKey(event('C', { shiftKey: true }), 'Shift+C')).toBe(true)
    expect(matchesKey(event('C', { shiftKey: true }), 'Shift+c')).toBe(true)
    expect(matchesKey(event('Enter', { shiftKey: true }), 'Enter')).toBe(false)
  })

  it('takes a symbol as typed, whatever Shift it needed', () => {
    expect(matchesKey(event('?', { shiftKey: true }), '?')).toBe(true)
    expect(matchesKey(event('?'), '?')).toBe(true)
    expect(matchesKey(event('/'), '/')).toBe(true)
    expect(matchesKey(event('['), '[')).toBe(true)
  })

  it('finds a letter by its place when ⌥ or the layout changes what it types', () => {
    expect(matchesKey(event('ç', { altKey: true, metaKey: true, code: 'KeyC' }), 'Alt+Mod+c')).toBe(
      true,
    )
    expect(matchesKey(event('т', { code: 'KeyN' }), 'n')).toBe(true)
    // A Latin layout's letter is taken as typed, never by its place.
    expect(matchesKey(event('a', { code: 'KeyQ' }), 'q')).toBe(false)
  })

  it('knows the spelled names for keys', () => {
    expect(matchesKey(event(' '), 'Space')).toBe(true)
    // Space is a key with its own Shift, not a symbol that carries one.
    expect(matchesKey(event(' ', { shiftKey: true }), 'Space')).toBe(false)
    expect(matchesKey(event(' ', { shiftKey: true }), 'Shift+Space')).toBe(true)
    expect(matchesKey(event(' '), 'Shift+Space')).toBe(false)
    expect(matchesKey(event('Escape'), 'Esc')).toBe(true)
    expect(matchesKey(event('Delete'), 'Delete')).toBe(true)
  })

  it('calls a key without ⌘, Ctrl or Alt a single key', () => {
    expect(isSingleKey('n')).toBe(true)
    expect(isSingleKey('Shift+R')).toBe(true)
    expect(isSingleKey('Escape')).toBe(true)
    expect(isSingleKey('Mod+k')).toBe(false)
    expect(isSingleKey('Alt+Mod+c')).toBe(false)
  })
})

describe('writing a key for the person', () => {
  it('uses the glyphs on a Mac and the words elsewhere', () => {
    expect(describeKey('Mod+k', true)).toBe('⌘K')
    expect(describeKey('Mod+k', false)).toBe('Ctrl+K')
    expect(describeKey('Shift+C', true)).toBe('⇧C')
    expect(describeKey('Shift+C', false)).toBe('Shift+C')
    expect(describeKey('Alt+Mod+c', true)).toBe('⌥⌘C')
    expect(describeKey('Alt+Mod+c', false)).toBe('Ctrl+Alt+C')
    expect(describeKey('Mod+Enter', true)).toBe('⌘↵')
  })

  it('keeps a single letter lowercase and names the named keys', () => {
    expect(describeKey('t', true)).toBe('t')
    expect(describeKey('?', true)).toBe('?')
    expect(describeKey('Escape', true)).toBe('Esc')
    expect(describeKey('ArrowUp', false)).toBe('↑')
    expect(describeKey('Space', false)).toBe('Space')
    expect(describeKey('Backspace', true)).toBe('⌫')
    expect(describeKey('Shift+F10', false)).toBe('Shift+F10')
  })
})

describe('telling a field from the page', () => {
  it('treats text inputs, text areas, selects and editable content as typing', () => {
    const text = document.createElement('input')
    const search = document.createElement('input')
    search.type = 'search'
    const radio = document.createElement('input')
    radio.type = 'radio'
    const select = document.createElement('select')
    const button = document.createElement('button')
    expect(isTyping(text)).toBe(true)
    expect(isTyping(search)).toBe(true)
    expect(isTyping(radio)).toBe(false)
    expect(isTyping(select)).toBe(true)
    expect(isTyping(button)).toBe(false)
    expect(isTyping(null)).toBe(false)
    expect(isTyping(window)).toBe(false)
  })
})
