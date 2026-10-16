// A Pub/Sub filter expression over attributes — `attributes.region = "eu"
// AND NOT hasPrefix(attributes.sku, "x")` — checked by the engine's own
// parser as it is typed (`POST /pubsub/filter/check`, 300 ms after the last
// keystroke), so "what would a subscription with this filter receive" is
// the same text, the same answer, in the message list and in the create
// dialog. A text that does not parse is marked where the parser stopped,
// underlined in the danger tone, with the parser's words under the line.

import { Button, Tooltip, cn } from '@cloudflare/kumo'
import { BracketsCurlyIcon, CheckIcon, XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { PubsubFilterCheck } from '@/api/generated/messaging/PubsubFilterCheck'
import { formatNumber } from '@/lib/format'
import { filterCheckQuery } from '../queries'

/** `value`, once it has held for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

/**
 * The engine's answer for `text` against `topic`'s history, `delayMs` after
 * the last change (300 ms for a field being typed into; none for a value
 * that has settled already, such as the URL's).
 */
export function useFilterCheck(
  project: string,
  text: string,
  topic: string | undefined,
  delayMs = 300,
): { check: PubsubFilterCheck | undefined; settled: boolean } {
  const settledText = useDebounced(text, delayMs)
  const query = useQuery(filterCheckQuery(project, settledText.trim(), topic))
  const settled = settledText === text && !query.isFetching
  return { check: text.trim() === '' ? undefined : query.data, settled }
}

/** One line under the field: the parser's reason and where, or what the filter passes. */
export function filterCheckText(
  check: PubsubFilterCheck | undefined,
  withMatches: boolean,
): string | undefined {
  if (!check) return undefined
  if (!check.ok) {
    const message = (check.message ?? 'This filter does not parse').replace(/\.$/, '')
    return check.position === null ? `${message}.` : `${message}, at ${check.position}`
  }
  if (!withMatches) return undefined
  if (check.checked === 0) return 'Valid · nothing published here yet to try it on'
  return `Valid · passes ${formatNumber(check.matched)} of the last ${formatNumber(check.checked)} messages`
}

/** The parse problem's span in the text: where the parser stopped, to the end of that word. */
function problemSpan(text: string, position: number): [number, number] {
  if (position >= text.length) return [text.length, text.length]
  let end = position + 1
  while (end < text.length && !/\s/.test(text[end] ?? '')) end += 1
  return [position, end]
}

const TEXT = 'px-1.5 font-mono text-[12px] leading-5 whitespace-pre'

export function AttributesFilterField({
  value,
  onChange,
  project,
  topic,
  collapsible = false,
  autoFocus = false,
  testId = 'attributes-filter',
}: {
  value: string
  onChange: (text: string) => void
  project: string
  /** The topic whose recent messages the check tries the filter on. */
  topic: string | undefined
  /** In a filter line: empty and unfocused, it is a ghost "Attributes…" button. */
  collapsible?: boolean
  autoFocus?: boolean
  testId?: string
}) {
  const [open, setOpen] = useState(!collapsible || value !== '')
  const input = useRef<HTMLInputElement>(null)
  const mirror = useRef<HTMLSpanElement>(null)
  const { check } = useFilterCheck(project, value, topic)
  // Opened again from outside (a link carrying `expr`).
  if (collapsible && value !== '' && !open) setOpen(true)

  const syncScroll = () => {
    if (mirror.current && input.current) mirror.current.scrollLeft = input.current.scrollLeft
  }
  useEffect(syncScroll)

  if (collapsible && !open)
    return (
      <Tooltip
        content="Filter by a Pub/Sub filter expression over attributes, as a subscription's filter reads them"
        render={
          <Button
            variant="ghost"
            size="sm"
            icon={<BracketsCurlyIcon />}
            onClick={() => {
              setOpen(true)
              requestAnimationFrame(() => input.current?.focus())
            }}
            className="shrink-0 !text-kumo-subtle hover:!text-kumo-default"
            data-testid={`${testId}-open`}
          >
            Attributes…
          </Button>
        }
      />
    )

  const invalid = check !== undefined && !check.ok
  const span = invalid && check.position !== null ? problemSpan(value, check.position) : undefined
  return (
    <div
      className={cn(
        'flex h-8 min-w-0 items-center rounded-lg pr-0.5 focus-within:bg-kumo-control focus-within:ring focus-within:ring-kumo-focus hover:not-focus-within:ink',
        collapsible ? 'w-[min(420px,40%)] shrink' : 'w-full ring ring-kumo-line',
        invalid && 'ring ring-kumo-danger',
      )}
      data-testid={testId}
      data-invalid={invalid ? '' : undefined}
    >
      <span className="flex h-full shrink-0 items-center pl-2 text-kumo-subtle" aria-hidden>
        <BracketsCurlyIcon size={14} />
      </span>
      <div className="relative grid h-full min-w-0 flex-1 items-center">
        {/* The text drawn again under the field, transparent but for the
            underline where the parser stopped. */}
        <span
          ref={mirror}
          aria-hidden
          className={cn(
            TEXT,
            'pointer-events-none col-start-1 row-start-1 overflow-hidden text-transparent',
          )}
        >
          {span ? (
            <>
              {value.slice(0, span[0])}
              <span className="border-b-2 border-kumo-danger">
                {span[0] === span[1] ? ' ' : value.slice(span[0], span[1])}
              </span>
              {value.slice(span[1])}
            </>
          ) : (
            value
          )}
        </span>
        <input
          ref={input}
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            syncScroll()
          }}
          onScroll={syncScroll}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            if (value !== '') onChange('')
            else if (collapsible) {
              setOpen(false)
              event.currentTarget.blur()
            }
          }}
          onBlur={() => {
            if (collapsible && value === '') setOpen(false)
          }}
          // A filter is typed the moment the dialog opens or the line is summoned.
          autoFocus={autoFocus}
          placeholder='attributes.region = "eu"'
          spellCheck={false}
          autoComplete="off"
          aria-label="Attributes filter expression"
          aria-invalid={invalid || undefined}
          className={cn(
            TEXT,
            'col-start-1 row-start-1 h-full min-w-0 bg-transparent text-kumo-default outline-none placeholder:text-kumo-inactive',
          )}
          data-testid={`${testId}-input`}
        />
      </div>
      {value !== '' && (
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<XIcon />}
          aria-label="Clear the expression"
          onClick={() => {
            onChange('')
            input.current?.focus()
          }}
          className="h-7 w-7 shrink-0 !text-kumo-subtle"
          data-testid={`${testId}-clear`}
        />
      )}
    </div>
  )
}

/** The check's line under a form field: the reason in the danger tone, or what it passes. */
export function FilterCheckLine({
  project,
  value,
  topic,
  testId = 'attributes-filter-check',
}: {
  project: string
  value: string
  topic: string | undefined
  testId?: string
}) {
  const { check } = useFilterCheck(project, value, topic)
  const text = filterCheckText(check, true)
  if (!text) return null
  return (
    <span
      className={cn(
        'flex items-center gap-1 text-[12px]',
        check?.ok ? 'text-kumo-subtle' : 'text-kumo-danger',
      )}
      data-testid={testId}
      data-ok={check?.ok ? '' : undefined}
    >
      {check?.ok && <CheckIcon size={12} className="shrink-0 text-kumo-success" />}
      {text}
    </span>
  )
}
