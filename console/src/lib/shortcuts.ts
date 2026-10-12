// One keyboard registry for the whole console. Every page used to add its
// own `keydown` listener to the window and repeat the same guards — is the
// person typing, is a value being edited — slightly differently each time,
// and nothing could list what the keys did. Now the shell holds the one
// listener (`useShortcutListener`), pages declare their keys with
// `useShortcuts`, and the `?` dialog reads the same declarations.
//
// The rules, in the order they are applied to a key press:
//
// - In a field (an input, a textarea, anything content-editable) a key goes
//   to the field, unless its shortcut says `allowInInputs` (⌘K, ⌘↵).
// - Inside an overlay — a dialog, a menu, a list box — single keys belong to
//   the overlay: Escape closes it, letters pick its items. Only modified
//   keys that allow inputs reach the page from there.
// - While a value is being edited (`useEditing`), single keys stand aside.
// - A shortcut whose `when()` is false is skipped, and the key falls through
//   to the next scope that binds it.
// - Of the scopes left, the most recently mounted wins: a page over the
//   shell, a dialog's own scope over its page.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type StoreApi, type UseBoundStore, create } from 'zustand'

export interface Shortcut {
  /** 'n', '/', '?', 'Escape', 'Enter', 'Delete', 'Mod+Enter', 'Mod+s' — Mod is ⌘ on macOS, Ctrl elsewhere. */
  key: string
  /** Sentence case: "New user". */
  label: string
  /** The dialog's heading; default: the scope's label. */
  group?: string
  run: (event: KeyboardEvent) => void
  when?: () => boolean
  allowInInputs?: boolean
}

export interface ShortcutScope {
  id: string
  label: string
}

/** The shell's scope: the keys that work on every page, listed first as "Everywhere". */
export const SHELL_SCOPE = 'shell'

/** One mounted `useShortcuts` call: what the dialog lists and the dispatcher reads. */
export interface ShortcutRegistration {
  /** Render order of the first mount: higher is more recent, and wins a key. */
  order: number
  scope: ShortcutScope
  /** The shortcuts as of the latest render, so a handler always sees current state. */
  read: () => readonly Shortcut[]
  /** Keys, labels and groups as registered; a new one replaces the registration. */
  signature: string
}

/** Every mounted scope, most recent first. */
export const useShortcutRegistry = create<{ registrations: readonly ShortcutRegistration[] }>(
  () => ({ registrations: [] }),
)

let nextOrder = 0

/** Registers while mounted; the most recently mounted scope wins a key. */
export function useShortcuts(scope: ShortcutScope, shortcuts: readonly Shortcut[]): void {
  // Taken while rendering, which runs parents before children: a page that
  // mounts after the shell outranks it, whatever order effects run in.
  const [order] = useState(() => {
    nextOrder += 1
    return nextOrder
  })
  const latest = useRef(shortcuts)
  // The newest handlers, without touching the registry: a grid re-renders
  // on every scroll frame, and its keys do not change when it does.
  useLayoutEffect(() => {
    latest.current = shortcuts
  })
  const signature = shortcuts
    .map((shortcut) =>
      [shortcut.key, shortcut.label, shortcut.group ?? '', shortcut.allowInInputs ? '1' : ''].join(
        '\u0000',
      ),
    )
    .join('\u0001')
  const { id, label } = scope
  useEffect(() => {
    const registration: ShortcutRegistration = {
      order,
      scope: { id, label },
      read: () => latest.current,
      signature,
    }
    register(registration)
    return () => unregister(order)
  }, [order, id, label, signature])
}

function register(registration: ShortcutRegistration) {
  const others = useShortcutRegistry
    .getState()
    .registrations.filter((entry) => entry.order !== registration.order)
  if (import.meta.env.DEV) warnOnConflicts(registration, others)
  useShortcutRegistry.setState({
    registrations: [...others, registration].toSorted((a, b) => b.order - a.order),
  })
}

function unregister(order: number) {
  useShortcutRegistry.setState((state) => ({
    registrations: state.registrations.filter((entry) => entry.order !== order),
  }))
}

function warnOnConflicts(
  registration: ShortcutRegistration,
  others: readonly ShortcutRegistration[],
) {
  const mine = new Set(registration.read().map((shortcut) => canonicalKey(shortcut.key)))
  for (const other of others)
    for (const shortcut of other.read()) {
      const key = canonicalKey(shortcut.key)
      if (!mine.has(key)) continue
      const [older, newer] =
        other.order < registration.order ? [other, registration] : [registration, other]
      // Two scopes on one key is a mistake to catch while building a page:
      // one of them silently never fires. Only development builds say so.
      // oxlint-disable-next-line no-console
      console.warn(
        `Two mounted keyboard scopes bind ${shortcut.key}: "${older.scope.label}" and "${newer.scope.label}". ` +
          `"${newer.scope.label}" was mounted last and wins it; give one of them another key (the reserved keys are in the console SKILL).`,
      )
    }
}

/**
 * A value is being edited somewhere (the grid's cell editor, an inline
 * field): single keys stand aside. Each editor calls `setEditing(true)` when
 * it opens and `setEditing(false)` when it closes; the flag holds while any
 * of them is open.
 */
export const useEditing: UseBoundStore<
  StoreApi<{ editing: boolean; setEditing: (editing: boolean) => void }>
> = create((set) => {
  let open = 0
  return {
    editing: false,
    setEditing: (editing) => {
      open = editing ? open + 1 : Math.max(0, open - 1)
      set({ editing: open > 0 })
    },
  }
})

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/** Whether a key pressed with focus on `target` is text for a field. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type)
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null
}

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

/** Whether focus is inside an overlay that owns its single keys. */
function inOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OVERLAY) !== null
}

/**
 * Whether ⌘ is the command key here. `navigator.platform` first: it names
 * the machine the browser runs on, while the user-agent hints follow a
 * user-agent override (a test browser posing as Windows on a Mac still
 * gets ⌘ from the keyboard).
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || data?.platform || '')
}

interface ParsedKey {
  /** The key itself, as `KeyboardEvent.key` names it ('Enter', 'a', '?', ' '). */
  key: string
  mod: boolean
  shift: boolean
  alt: boolean
  ctrl: boolean
  meta: boolean
}

const ALIASES: Record<string, string> = { Space: ' ', Esc: 'Escape', Del: 'Delete' }

function parseKey(spec: string): ParsedKey {
  const parts = spec.endsWith('++') ? [...spec.slice(0, -2).split('+'), '+'] : spec.split('+')
  const key = parts.pop() ?? ''
  const modifiers = new Set(parts.map((part) => part.toLowerCase()))
  return {
    key: ALIASES[key] ?? key,
    mod: modifiers.has('mod'),
    shift: modifiers.has('shift'),
    alt: modifiers.has('alt') || modifiers.has('option'),
    ctrl: modifiers.has('ctrl') || modifiers.has('control'),
    meta: modifiers.has('meta') || modifiers.has('cmd'),
  }
}

/** One spelling per key, for telling two bindings of the same key apart. */
function canonicalKey(spec: string): string {
  const parsed = parseKey(spec)
  const meta = parsed.meta || (parsed.mod && isMac())
  const ctrl = parsed.ctrl || (parsed.mod && !isMac())
  const key = parsed.key.length === 1 ? parsed.key.toLowerCase() : parsed.key
  return [ctrl && 'ctrl', parsed.alt && 'alt', parsed.shift && 'shift', meta && 'meta', key]
    .filter(Boolean)
    .join('+')
}

/** A shortcut with no ⌘, Ctrl or Alt: one that stands aside while a value is edited. */
export function isSingleKey(spec: string): boolean {
  const parsed = parseKey(spec)
  return !parsed.mod && !parsed.alt && !parsed.ctrl && !parsed.meta
}

/** Whether `event` is the key `spec` names, with exactly its modifiers. */
export function matchesKey(event: KeyboardEvent, spec: string): boolean {
  const parsed = parseKey(spec)
  const mac = isMac()
  if (event.metaKey !== (parsed.meta || (parsed.mod && mac))) return false
  if (event.ctrlKey !== (parsed.ctrl || (parsed.mod && !mac))) return false
  if (event.altKey !== parsed.alt) return false
  const { key } = parsed
  if (/^[a-z]$/i.test(key)) {
    if (event.shiftKey !== parsed.shift) return false
    // A Latin letter is matched as typed, so a shortcut follows the
    // keyboard layout; with ⌥ held, or on a layout without Latin letters,
    // the key's position is what is left to go by.
    if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === key.toLowerCase()
    return event.code === `Key${key.toUpperCase()}`
  }
  if (key === ' ') {
    // Space is a key, not a symbol: Shift+Space is a key of its own (Storage's
    // Quick Look), so the table's Space must not take it.
    return event.shiftKey === parsed.shift && event.key === ' '
  }
  if (key.length === 1) {
    // A symbol carries its own Shift: `?` is Shift+/ on one layout and a key
    // of its own on another, so Shift is only checked when it is asked for.
    if (parsed.shift && !event.shiftKey) return false
    return event.key === key
  }
  return event.shiftKey === parsed.shift && event.key === key
}

/**
 * Runs the shortcut `event` asks for, if any; returns whether one ran (and
 * then the event's default is prevented). The shell's listener calls this;
 * tests call it directly.
 */
export function dispatchShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false
  const typing = isTyping(event.target)
  const overlay = inOverlay(event.target)
  const editing = useEditing.getState().editing
  for (const registration of useShortcutRegistry.getState().registrations)
    for (const shortcut of registration.read()) {
      if (!matchesKey(event, shortcut.key)) continue
      const single = isSingleKey(shortcut.key)
      if (typing && !shortcut.allowInInputs) continue
      if (overlay && (single || !shortcut.allowInInputs)) continue
      if (editing && single) continue
      if (shortcut.when && !shortcut.when()) continue
      event.preventDefault()
      shortcut.run(event)
      return true
    }
  return false
}

/** The one `keydown` listener; the shell mounts it once. */
export function useShortcutListener(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      dispatchShortcut(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

const NAMES: Record<string, string> = {
  Escape: 'Esc',
  Enter: '↵',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: '⌫',
  Delete: 'Del',
  ' ': 'Space',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ContextMenu: 'Menu',
  Tab: 'Tab',
}

/**
 * How a key is written for the person: `⌘K`, `⇧⌘C`, `?` on a Mac;
 * `Ctrl+K`, `Ctrl+Shift+C` elsewhere. A single letter stays lowercase, the
 * way it is pressed; with a modifier it is a key cap, uppercase.
 */
export function describeKey(spec: string, mac = isMac()): string {
  const parsed = parseKey(spec)
  const named = NAMES[parsed.key] ?? parsed.key
  const modified = parsed.mod || parsed.ctrl || parsed.meta || parsed.alt || parsed.shift
  const key = named.length === 1 && modified ? named.toUpperCase() : named
  if (mac) {
    const glyphs = [
      parsed.ctrl ? '⌃' : '',
      parsed.alt ? '⌥' : '',
      parsed.shift ? '⇧' : '',
      parsed.mod || parsed.meta ? '⌘' : '',
    ].join('')
    return `${glyphs}${key}`
  }
  const words = [
    parsed.mod || parsed.ctrl ? 'Ctrl' : '',
    parsed.meta ? 'Win' : '',
    parsed.alt ? 'Alt' : '',
    parsed.shift ? 'Shift' : '',
  ].filter(Boolean)
  return [...words, key].join('+')
}
