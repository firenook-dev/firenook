// The one toast policy. Toasts come from places that do not know about each
// other — a job finishing in another tab, a code arriving in the Auth inbox,
// the engine restarting — and left alone they pile up, repeat and announce
// the console's own changes back to the person who just made them. So:
//
// - at most three are stacked, and the oldest goes to make room;
// - a toast with the same `key` as one on screen replaces it in place
//   (its timer starts again) instead of stacking a copy;
// - an event replayed on reconnect, or the console's own change coming
//   back through the live channel (`echo`), is never shown.
//
// `toast()` works from anywhere, a timer or a live handler included: the
// shell hands `consoleToasts` to Kumo's `Toasty`, which renders them.

import { createKumoToastManager } from '@cloudflare/kumo'

export interface ToastOptions {
  /** Same key, same toast: a second call replaces the first. */
  key: string
  title: string
  description?: string | undefined
  tone?: 'info' | 'success' | 'warning' | 'danger' | undefined
  action?: { label: string; run: () => void } | undefined
  /** Replayed on reconnect: already seen, never shown again. */
  replayed?: boolean | undefined
  /** The console's own change, coming back: the person already knows. */
  echo?: boolean | undefined
}

type ToastAction = { children: string; onClick: () => void; variant: 'secondary'; size: 'sm' }

/** What the policy needs of a toast manager; Kumo's has it. */
export interface ToastSink {
  add(options: {
    id: string
    title: string
    description?: string | undefined
    variant?: 'default' | 'success' | 'error' | 'warning' | 'info'
    actions?: ToastAction[]
    onClose?: () => void
  }): unknown
  close(id: string): void
  /**
   * Changes what a toast on screen says. Kumo's `add` with the id of a
   * toast still showing only bumps it, keeping its old title, description
   * and actions (a finished job's toast went on reading "0 of 1" with
   * Cancel), so a replacement is written here first.
   */
  update?(
    id: string,
    options: {
      title: string
      description: string | undefined
      variant: 'default' | 'success' | 'error' | 'warning' | 'info'
      actions: ToastAction[] | undefined
    },
  ): unknown
}

const VARIANT = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'error',
} as const

export const TOAST_LIMIT = 3

/** The policy over any sink; `toast` is it over the console's manager. */
export function createToastPolicy(sink: ToastSink, limit = TOAST_LIMIT) {
  /** Toasts on screen, oldest first: their key and the id the sink knows them by. */
  const open: Array<{ key: string; id: string }> = []
  let serial = 0

  return function show(options: ToastOptions): void {
    if (options.replayed || options.echo) return
    const variant = options.tone ? VARIANT[options.tone] : 'default'
    const actions: ToastAction[] | undefined = options.action
      ? [
          {
            children: options.action.label,
            onClick: options.action.run,
            variant: 'secondary',
            size: 'sm',
          },
        ]
      : undefined
    const existing = open.findIndex((entry) => entry.key === options.key)
    let id: string
    if (existing === -1) {
      while (open.length >= limit) {
        const oldest = open.shift()
        if (oldest) sink.close(oldest.id)
      }
      serial += 1
      id = `${options.key}#${serial}`
    } else {
      // The same toast again: refreshed where it is, and the newest now,
      // saying what the new one says (an action it no longer has goes).
      const [entry] = open.splice(existing, 1)
      id = entry?.id ?? options.key
      sink.update?.(id, {
        title: options.title,
        description: options.description,
        variant,
        actions,
      })
    }
    open.push({ key: options.key, id })
    sink.add({
      id,
      title: options.title,
      description: options.description,
      variant,
      ...(actions ? { actions } : {}),
      onClose: () => {
        const at = open.findIndex((entry) => entry.id === id)
        if (at !== -1) open.splice(at, 1)
      },
    })
  }
}

/** The console's toast manager; the shell's `Toasty` renders what it holds. */
export const consoleToasts = createKumoToastManager()

/**
 * At most 3 stacked (the oldest goes); the same `key` replaces instead of
 * stacking; `replayed` and `echo` (the console's own change coming back)
 * are never shown.
 */
export const toast: (options: ToastOptions) => void = createToastPolicy(consoleToasts)
