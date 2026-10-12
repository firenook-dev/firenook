// A value that is hidden until it is asked for: a password hash, a salt, a
// refresh token, a secret, a download token. It reads `•••• (88 characters)`
// with an eye beside it, so the shape of the thing is there — it exists, it
// is this long — without the thing itself sitting on a screen somebody is
// sharing.
//
// The value is either here already (`value`) or fetched only when asked for
// (`reveal`, which the engine answers): a secret the console never needed
// is a secret it never held. It is never copied before it is revealed,
// because a copy of something you have not seen is a paste you cannot
// check, and an error is said where the value would have been.

import { Tooltip } from '@cloudflare/kumo'
import { EyeIcon, EyeSlashIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { CopyGlyph, useCopied } from '@/components/kit'
import { formatNumber } from '@/lib/format'

/** `•••• (88 characters)`, or the dots alone when the length is not known. */
export function maskedText(length: number | undefined): string {
  if (length === undefined) return '••••••••'
  return `•••• (${formatNumber(length)} ${length === 1 ? 'character' : 'characters'})`
}

/** "Show the secret" → "Hide the secret". */
function hideLabel(label: string): string {
  return /^show\b/i.test(label) ? label.replace(/^show/i, 'Hide') : `Hide: ${label}`
}

/**
 * A square as small as the 20 px line it sits on — Kumo's own extra-small
 * square renders 12 px at this root, below any hit target, and its small one
 * is taller than the line. Hand-made squares take `rounded-md` and `hover:ink`.
 */
const SQUARE =
  'flex h-5 w-5 items-center justify-center rounded-md text-kumo-subtle outline-none hover:ink hover:text-kumo-default focus-visible:ring focus-visible:ring-kumo-focus disabled:text-kumo-inactive disabled:hover:bg-none'

type Reveal =
  | { state: 'hidden' }
  | { state: 'pending' }
  | { state: 'shown'; value: string }
  | { state: 'failed'; message: string }

export function MaskedValue({
  length,
  value,
  reveal,
  label,
  copyable = false,
  revealed: revealedProp,
  onRevealedChange,
  testId,
}: {
  /** How long the hidden value is, when only the engine holds it. */
  length?: number | undefined
  /** The value, when it is here already. */
  value?: string | undefined
  /** Fetches the value; asked only when someone presses the eye. */
  reveal?: ((signal: AbortSignal) => Promise<string>) | undefined
  /** What the eye does: "Show the secret". */
  label: string
  /** Offer a copy button once the value is shown. */
  copyable?: boolean | undefined
  /** Shown or not, when the owner keeps that state (a tree that copies only what was shown). */
  revealed?: boolean | undefined
  onRevealedChange?: ((revealed: boolean) => void) | undefined
  testId?: string | undefined
}) {
  const [own, setOwn] = useState<Reveal>({ state: 'hidden' })
  const [fetched, setFetched] = useState<string | undefined>()
  const abort = useRef<AbortController | null>(null)
  const { copied, copy } = useCopied()
  useEffect(() => () => abort.current?.abort(), [])

  const known = value ?? fetched
  const wanted = revealedProp ?? own.state !== 'hidden'
  // What is drawn: a value that is here shows at once; one that is fetched
  // shows its fetch's state.
  const view: Reveal = !wanted
    ? { state: 'hidden' }
    : known !== undefined
      ? { state: 'shown', value: known }
      : own.state === 'failed' || own.state === 'pending'
        ? own
        : { state: 'pending' }

  const fetchValue = () => {
    if (!reveal) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setOwn({ state: 'pending' })
    reveal(controller.signal).then(
      (secret) => {
        if (controller.signal.aborted) return
        setFetched(secret)
        setOwn({ state: 'shown', value: secret })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setOwn({
          state: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }

  const toggle = () => {
    const next = !wanted
    onRevealedChange?.(next)
    if (!next) {
      abort.current?.abort()
      setOwn({ state: 'hidden' })
      return
    }
    if (known === undefined) fetchValue()
    else setOwn({ state: 'shown', value: known })
  }

  const shownLength = known?.length ?? length
  const name = view.state === 'hidden' ? label : hideLabel(label)
  return (
    <span className="inline-flex max-w-full min-w-0 items-start gap-1" data-testid={testId}>
      {view.state === 'shown' ? (
        <span
          className="min-w-0 font-mono text-[12px] leading-5 break-all text-kumo-default"
          data-testid={testId && `${testId}-value`}
        >
          {view.value}
        </span>
      ) : view.state === 'failed' ? (
        <span
          className="min-w-0 text-[12px] leading-5 text-kumo-danger"
          data-testid={testId && `${testId}-error`}
        >
          {view.message}
        </span>
      ) : (
        <span
          className={`min-w-0 font-mono text-[12px] leading-5 ${view.state === 'pending' ? 'text-kumo-inactive' : 'text-kumo-subtle'}`}
          aria-busy={view.state === 'pending' || undefined}
          data-testid={testId && `${testId}-masked`}
        >
          {view.state === 'pending' ? 'Revealing…' : maskedText(shownLength)}
        </span>
      )}
      <span className="flex h-5 shrink-0 items-center gap-0.5">
        <Tooltip
          content={view.state === 'failed' ? 'Try again' : name}
          render={
            <button
              type="button"
              className={SQUARE}
              aria-label={view.state === 'failed' ? `${label} (try again)` : name}
              aria-pressed={view.state !== 'hidden'}
              disabled={value === undefined && reveal === undefined}
              onClick={view.state === 'failed' ? fetchValue : toggle}
              data-testid={testId && `${testId}-reveal`}
            >
              {view.state === 'hidden' || view.state === 'failed' ? (
                <EyeIcon size={13} />
              ) : (
                <EyeSlashIcon size={13} />
              )}
            </button>
          }
        />
        {copyable && view.state === 'shown' && (
          <Tooltip
            content={copied ? 'Copied' : 'Copy'}
            render={
              <button
                type="button"
                className={SQUARE}
                aria-label={copied ? 'Copied' : 'Copy the value'}
                onClick={() => void copy(view.value)}
                data-testid={testId && `${testId}-copy`}
              >
                <span className="text-[13px]">
                  <CopyGlyph copied={copied} />
                </span>
              </button>
            }
          />
        )}
      </span>
    </span>
  )
}
