// The filter field every list's second toolbar row leads with: one line of
// the shared filter language (`provider:google.com -is:disabled ada`), the
// URL's `q` its truth, checked the way the engine checks it.
//
// It is the path field's twin: one 32 px box, flat at rest, a ground under
// the pointer, the focus ring only while it has focus, and a `ring-kumo-
// danger` outline at rest when what is in it cannot be used — with why
// under it, the offending span underlined. Each term is drawn on a tinted
// ground behind its text, by a mirror of the text laid under a transparent
// input (the `Grows` technique), so `-is:disabled` reads as one thing and
// typing is still typing into a plain input.
//
// What only the engine can check (the regex syntax a section compiles) is
// said the same way: a refusal of the text, with its span, given back as
// `refusal` and shown while the field still holds that text.
//
// Completions hang under it in a portal: at a key, the list's keys with
// their help lines; after `key:`, that field's values — an enum's, a
// boolean's, a few times and sizes to start from, and whatever `suggest`
// knows (bucket names, function names). `/` and `f` focus it.

import { Tooltip } from '@cloudflare/kumo'
import { FunnelIcon, XIcon } from '@phosphor-icons/react'
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  type FilterContext,
  type FilterError,
  type FilterFieldDef,
  asciiLower,
  checkFilter,
  contextAt,
  enumAliases,
  fieldFor,
  filterTokens,
  filterValueText,
} from '@/lib/filter'
import { useShortcuts } from '@/lib/shortcuts'
import { Anchored } from './completions'

export interface FilterFieldSpec extends FilterFieldDef {
  help: string
  /** More values for completion — bucket names, function names — given what is typed so far. */
  suggest?: ((prefix: string) => readonly string[] | Promise<readonly string[]>) | undefined
}

/** One row of the completion list. */
export interface FilterCompletion {
  /** What the row shows: `provider:`, `google.com`. */
  label: string
  /** What goes into the text. */
  insert: string
  detail?: string | undefined
  /** A key gets its separator; a path prefix waits for the name after it; a value ends the item. */
  role: 'key' | 'prefix' | 'path' | 'value'
}

const TIMES: readonly [string, string][] = [
  ['today', 'Midnight today, UTC'],
  ['-15m', '15 minutes ago'],
  ['-1h', 'An hour ago'],
  ['-24h', 'A day ago'],
  ['-7d', 'A week ago'],
  ['now', 'This moment'],
]
const DURATIONS: readonly [string, string][] = [
  ['100ms', ''],
  ['1s', ''],
  ['10s', ''],
  ['1m', ''],
]
const SIZES: readonly [string, string][] = [
  ['1KB', ''],
  ['100KB', ''],
  ['1MB', ''],
  ['10MB', ''],
]

function starts(text: string, prefix: string): boolean {
  return asciiLower(text).startsWith(asciiLower(prefix))
}

/**
 * The completions a context offers from the fields alone (`suggest`'s are
 * added by the field as they arrive).
 */
export function staticCompletions(
  context: FilterContext,
  fields: readonly FilterFieldDef[],
): FilterCompletion[] {
  if (context.kind === 'key') {
    const items: FilterCompletion[] = []
    for (const field of fields) {
      if (field.kind === 'path') {
        for (const prefix of field.prefixes ?? [])
          if (starts(prefix, context.prefix))
            items.push({ label: prefix, insert: prefix, detail: field.help, role: 'prefix' })
        continue
      }
      const alias = (field.aliases ?? []).find((item) => starts(item, context.prefix))
      if (starts(field.key, context.prefix) || alias !== undefined)
        items.push({
          label: `${field.key}:`,
          insert: field.key,
          detail:
            !starts(field.key, context.prefix) && alias !== undefined
              ? `${field.help} · also ${alias}`
              : field.help,
          role: 'key',
        })
    }
    return items
  }
  if (context.kind !== 'value') return []
  const field = fieldFor(context.key, fields)
  if (!field) return []
  const pick = (pairs: readonly [string, string][]) =>
    pairs
      .filter(([value]) => starts(value, context.prefix))
      .map(([value, detail]): FilterCompletion => ({
        label: value,
        insert: value,
        detail,
        role: 'value',
      }))
  switch (field.kind) {
    case 'enum': {
      const aliases = enumAliases(field)
      return (field.values ?? []).flatMap((value): FilterCompletion[] => {
        const spellings = aliases.filter(([, target]) => target === value).map(([alias]) => alias)
        const matches =
          starts(value, context.prefix) || spellings.some((alias) => starts(alias, context.prefix))
        return matches
          ? [
              {
                label: value,
                insert: value,
                detail: spellings.length > 0 ? `also ${spellings.join(', ')}` : undefined,
                role: 'value',
              },
            ]
          : []
      })
    }
    case 'bool':
      return pick([
        ['true', ''],
        ['false', ''],
      ])
    case 'time':
      return pick(TIMES)
    case 'duration':
      return pick(DURATIONS)
    case 'bytes':
      return pick(SIZES)
    default:
      return []
  }
}

/** The text with a completion put in, and where the caret goes after it. */
export function applyCompletion(
  text: string,
  context: FilterContext,
  item: FilterCompletion,
): { text: string; caret: number } {
  if (context.kind === 'none' || context.kind === 'word') return { text, caret: text.length }
  const before = text.slice(0, context.from)
  const after = text.slice(context.to)
  if (item.role === 'value') {
    const written = filterValueText(item.insert)
    const space = after === '' ? ' ' : ''
    const next = `${before}${written}${space}${after}`
    return { text: next, caret: before.length + written.length + space.length }
  }
  if (item.role === 'prefix') {
    const next = `${before}${item.insert}${after}`
    return { text: next, caret: before.length + item.insert.length }
  }
  // A key, or a full path key: its separator follows, kept if it is there.
  const separated = 'hasSeparator' in context && context.hasSeparator
  const next = `${before}${item.insert}${separated ? '' : ':'}${after}`
  return { text: next, caret: before.length + item.insert.length + 1 }
}

/**
 * The engine's refusal of a filter text the browser could not check — a
 * regex its syntax lacks — with the message and the UTF-16 span it gave.
 */
export interface FilterRefusal extends FilterError {
  /** The text the engine refused; shown only while the field holds it. */
  text: string
}

/** Whether an error belongs to the item the caret is still typing. */
function underCaret(error: FilterError, caret: number): boolean {
  return error.from <= caret && caret <= error.to
}

/**
 * The field's box: the path field's twin (`workbench.tsx`, `query-line.tsx`).
 * No `flex-1` here: the box sits in this component's own column, where a
 * zero flex basis would beat its height and fold it to one text line.
 */
const BOX =
  'flex h-8 min-w-0 shrink-0 items-center rounded-lg pr-0.5 focus-within:bg-kumo-control focus-within:ring focus-within:ring-kumo-focus hover:not-focus-within:ink'
/** Metrics the input and its mirror must share to the pixel. */
const TEXT = 'px-1.5 font-mono text-[12px] leading-5'

export function FilterField({
  value,
  onChange,
  fields,
  placeholder,
  ariaLabel,
  regex = false,
  refusal,
  testId,
}: {
  /** The URL's `q`: the truth. */
  value: string
  /** Every edit; the caller debounces it into the URL (`replace: true`). */
  onChange: (text: string) => void
  /** The list's fields (`ListMeta.fields`), with live `suggest`ions where it has them. */
  fields: readonly FilterFieldSpec[]
  /** "Filter users — provider:google.com -is:disabled ada". */
  placeholder: string
  ariaLabel: string
  /** `/regex/` items are items in this list (Logs). */
  regex?: boolean | undefined
  /** What the engine refused of a text that parses here (Logs' regexes): shown as a parse error is. */
  refusal?: FilterRefusal | undefined
  testId?: string | undefined
}) {
  const ids = testId ?? 'filter-field'
  const listId = useId()
  const errorId = useId()
  const input = useRef<HTMLInputElement>(null)
  const mirror = useRef<HTMLSpanElement>(null)

  // The text being typed. The URL follows behind it (the caller debounces),
  // so what comes back as `value` is either an echo of something typed here
  // — ignored — or a change from elsewhere (a facet, Back), which replaces it.
  const [draft, setDraft] = useState(value)
  const [echoes, setEchoes] = useState<readonly string[]>([value])
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (!echoes.includes(value)) {
      setDraft(value)
      setEchoes([value])
    }
  }

  const [caret, setCaret] = useState(value.length)
  const [focused, setFocused] = useState(false)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [suggested, setSuggested] = useState<{ for: string; items: FilterCompletion[] }>({
    for: '',
    items: [],
  })

  const result = checkFilter(draft, { fields, regex })
  const refused =
    refusal && refusal.text === draft
      ? { message: refusal.message, from: refusal.from, to: refusal.to }
      : undefined
  const error = result.ok ? refused : result.error
  // While an item is still being typed its error waits; the ring and the
  // message come back the moment the caret leaves it or the field.
  const shownError = error && !(focused && underCaret(error, caret)) ? error : undefined

  const context = contextAt(draft, caret, { regex, fields })
  const contextKey = `${context.kind}\u0000${'prefix' in context ? context.prefix : ''}\u0000${
    context.kind === 'value' ? context.key : context.kind === 'path' ? context.field.key : ''
  }`
  const suggestFor = (() => {
    if (context.kind === 'value') {
      const field = fieldFor(context.key, fields) as FilterFieldSpec | undefined
      return field?.suggest ? { field, prefix: context.prefix } : undefined
    }
    if (context.kind === 'path') {
      const field = context.field as FilterFieldSpec
      return field.suggest ? { field, prefix: context.prefix } : undefined
    }
    return undefined
  })()

  // `suggest` may answer at once or later; a later answer for an older
  // prefix is dropped. The effect keys on the context alone: the caller's
  // field list (and its functions) may be new on every render.
  const asked = useRef(suggestFor)
  useLayoutEffect(() => {
    asked.current = suggestFor
  })
  const role: FilterCompletion['role'] = context.kind === 'path' ? 'path' : 'value'
  useEffect(() => {
    const ask = asked.current
    if (!open || !ask) return
    let current = true
    const take = (values: readonly string[]) => {
      if (!current) return
      setSuggested({
        for: contextKey,
        items: values.slice(0, 50).map((item) => ({ label: item, insert: item, role })),
      })
    }
    try {
      const answer = ask.field.suggest?.(ask.prefix) ?? []
      if (Array.isArray(answer)) take(answer)
      else void Promise.resolve(answer).then(take, () => take([]))
    } catch {
      take([])
    }
    return () => {
      current = false
    }
  }, [open, contextKey, role, asked])

  const fromFields = staticCompletions(context, fields)
  const live =
    suggestFor && suggested.for === contextKey
      ? suggested.items.filter((item) => !fromFields.some((known) => known.insert === item.insert))
      : []
  const items = [...fromFields, ...live]
  const pathHelp =
    context.kind === 'path' && items.length === 0
      ? `${context.field.prefixes?.[0] ?? context.field.key}… · ${context.field.help ?? ''}`
      : undefined
  const showing = open && focused && (items.length > 0 || pathHelp !== undefined)
  // Something typed means a choice is being narrowed, so the first match is
  // the one Enter takes; with nothing typed, Enter takes nothing until an
  // arrow says so.
  const typedPrefix = 'prefix' in context && context.prefix !== ''
  const active =
    highlight >= 0 && highlight < items.length
      ? highlight
      : typedPrefix && items.length > 0
        ? 0
        : -1

  const commit = (text: string, nextCaret?: number) => {
    setDraft(text)
    setEchoes((current) => [...current.slice(-19), text])
    onChange(text)
    if (nextCaret !== undefined) {
      setCaret(nextCaret)
      requestAnimationFrame(() => {
        input.current?.setSelectionRange(nextCaret, nextCaret)
        sync()
      })
    }
  }
  const pick = (item: FilterCompletion) => {
    const next = applyCompletion(draft, context, item)
    commit(next.text, next.caret)
    // A key or a prefix leads on to what follows it; a value ends the item.
    setOpen(item.role !== 'value')
    setHighlight(-1)
  }
  const readCaret = () => setCaret(input.current?.selectionStart ?? draft.length)
  /** Keeps the mirror under the input's text as it scrolls sideways. */
  const sync = () => {
    if (mirror.current && input.current)
      mirror.current.style.transform = `translateX(${-input.current.scrollLeft}px)`
  }
  useLayoutEffect(sync)

  useShortcuts({ id: `filter:${ids}`, label: 'Filter' }, [
    { key: '/', label: 'Focus the filter', run: () => input.current?.focus() },
    { key: 'f', label: 'Focus the filter', run: () => input.current?.focus() },
  ])

  const tokens = filterTokens(draft, regex)
  const painted: ReactNode[] = []
  let at = 0
  const push = (from: number, to: number, className?: string) => {
    if (to <= from) return
    const text = draft.slice(from, to)
    painted.push(
      className ? (
        <span key={`${from}:${to}`} className={className}>
          {text}
        </span>
      ) : (
        text
      ),
    )
  }
  for (const token of tokens) {
    push(at, token.from)
    push(
      token.from,
      token.to,
      token.kind === 'term' || token.kind === 'regex'
        ? 'rounded-[3px] bg-kumo-fill ring-2 ring-kumo-fill'
        : undefined,
    )
    at = token.to
  }
  push(at, draft.length)

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1" data-testid={ids}>
      <div
        className={`${BOX} ${shownError ? 'ring ring-kumo-danger' : ''}`}
        data-testid={`${ids}-box`}
        data-invalid={shownError ? 'true' : undefined}
      >
        <label className="flex h-full min-w-0 flex-1 cursor-text items-center pl-2">
          <FunnelIcon size={14} className="shrink-0 text-kumo-subtle" />
          <span className="relative flex h-full min-w-0 flex-1 items-center">
            {/* The mirror: the same text, invisible, with each term's ground
                and the error's underline painted under where the input
                draws it. */}
            <span
              className={`pointer-events-none absolute inset-0 flex items-center overflow-x-clip whitespace-pre text-transparent ${TEXT}`}
              aria-hidden
            >
              <span ref={mirror} className="relative">
                {painted}
                {shownError && <ErrorSpan text={draft} error={shownError} />}
              </span>
            </span>
            <input
              ref={input}
              value={draft}
              role="combobox"
              aria-expanded={showing}
              aria-controls={showing ? listId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={showing && active >= 0 ? `${listId}-${active}` : undefined}
              aria-label={ariaLabel}
              aria-invalid={shownError ? true : undefined}
              aria-describedby={shownError ? errorId : undefined}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                commit(event.target.value)
                setCaret(event.target.selectionStart ?? event.target.value.length)
                setOpen(true)
                setHighlight(-1)
              }}
              onFocus={() => {
                setFocused(true)
                setOpen(true)
                readCaret()
              }}
              onBlur={() => {
                setFocused(false)
                setOpen(false)
              }}
              onSelect={() => {
                readCaret()
                sync()
              }}
              onScroll={sync}
              onKeyDown={(event) => {
                const handled = () => {
                  event.preventDefault()
                  event.stopPropagation()
                }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  if (!showing) {
                    if (event.key === 'ArrowDown') {
                      setOpen(true)
                      handled()
                    }
                    return
                  }
                  if (items.length === 0) return
                  const down = event.key === 'ArrowDown'
                  setHighlight(
                    active === -1
                      ? down
                        ? 0
                        : items.length - 1
                      : (active + (down ? 1 : -1) + items.length) % items.length,
                  )
                  handled()
                } else if (
                  (event.key === 'Enter' || event.key === 'Tab') &&
                  showing &&
                  !event.shiftKey
                ) {
                  const item =
                    items[active === -1 && event.key === 'Tab' && items.length > 0 ? 0 : active]
                  if (!item) return
                  pick(item)
                  handled()
                } else if (event.key === 'Escape' && showing) {
                  setOpen(false)
                  handled()
                }
              }}
              className={`relative h-full min-w-0 flex-1 bg-transparent text-kumo-default outline-none placeholder:font-sans placeholder:text-kumo-inactive ${TEXT}`}
              data-testid={`${ids}-input`}
            />
          </span>
        </label>
        {draft !== '' && (
          <Tooltip
            content="Clear the filter"
            render={
              <button
                type="button"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-kumo-subtle outline-none hover:ink hover:text-kumo-default focus-visible:ring focus-visible:ring-kumo-focus"
                aria-label="Clear the filter"
                onClick={() => {
                  commit('', 0)
                  input.current?.focus()
                }}
                data-testid={`${ids}-clear`}
              >
                <XIcon size={14} />
              </button>
            }
          />
        )}
      </div>
      {shownError && (
        <p
          id={errorId}
          className="m-0 px-2 text-[12px] leading-4 text-kumo-danger"
          data-testid={`${ids}-error`}
        >
          {shownError.message}
        </p>
      )}
      {showing && (
        // As wide as what it lists, not as the field: a filter runs the
        // width of the toolbar, and a help line pushed to its far end is a
        // help line nobody reads beside its key.
        <Anchored anchor={input} testId={`${ids}-completions`} room={240} width="content">
          <ul
            id={listId}
            role="listbox"
            aria-label={`${ariaLabel}: completions`}
            className="max-h-60 max-w-[min(32rem,calc(100vw-2rem))] min-w-64 overflow-auto p-1"
          >
            {pathHelp !== undefined && (
              <li className="px-2 py-1 font-mono text-[11px] text-kumo-subtle" role="presentation">
                {pathHelp}
              </li>
            )}
            {items.map((item, index) => (
              <li
                key={`${item.role}:${item.insert}`}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`flex cursor-default items-center gap-6 rounded-md px-2 py-1 ${
                  index === active ? 'bg-kumo-tint' : 'hover:ink'
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => pick(item)}
                data-testid={`${ids}-completion`}
              >
                <span className="min-w-0 shrink-0 truncate font-mono text-[12px] text-kumo-default">
                  {item.label}
                </span>
                {item.detail && (
                  <span className="ml-auto min-w-0 truncate text-[12px] text-kumo-subtle">
                    {item.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Anchored>
      )}
    </div>
  )
}

/** The error's span, underlined in the mirror under the text it is about. */
function ErrorSpan({ text, error }: { text: string; error: FilterError }) {
  // Laid over the painted text: everything before the span takes its room
  // invisibly, then the span itself carries the underline.
  return (
    <span className="absolute inset-y-0 left-0 whitespace-pre" aria-hidden>
      {text.slice(0, error.from)}
      <span className="underline decoration-kumo-danger decoration-wavy decoration-1 underline-offset-[3px]">
        {error.to > error.from ? text.slice(error.from, error.to) : ' '}
      </span>
    </span>
  )
}
