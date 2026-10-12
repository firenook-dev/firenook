// Pairs of a key and a value, edited as rows or as text: request headers and
// query parameters, message attributes, custom metadata.
//
// Rows are for a few pairs and for seeing what is switched off; the text is
// for pasting twenty headers out of a terminal. They are one list written
// two ways (`rowsToText`, `textToRows`): text that reads becomes rows on the
// keystroke, and the lines that do not read are said by number and keep the
// text view open, so nothing typed is lost to a switch.
//
// The add line sits under the rows and is always there: typing into it is
// adding a row, and focus goes on into that row so the next keystroke lands
// where it was meant. What is wrong — a key twice, a key the list refuses, a
// value with no key — is said on the row it is wrong on.

import { Button, Checkbox, Tooltip } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useEffect, useId, useRef, useState } from 'react'
import { Completion, Completions } from './completions'

export interface KeyValueRow {
  id: string
  key: string
  value: string
  enabled: boolean
}

let nextId = 0
/** A fresh row id, unique in this page. */
export function rowId(): string {
  nextId += 1
  return `kv-${nextId}`
}

/** The rows as text: `key: value` per line, a switched-off row behind `// `. */
export function rowsToText(rows: readonly KeyValueRow[]): string {
  return rows
    .filter((row) => row.key !== '' || row.value !== '')
    .map((row) => `${row.enabled ? '' : '// '}${row.key}: ${row.value}`)
    .join('\n')
}

/**
 * Text back to rows: one `key: value` per line (split at the first colon, so
 * a value may hold more), `//` switching a row off, blank lines skipped. A
 * line it cannot read is a problem with its number, and no row.
 */
export function textToRows(text: string): {
  rows: KeyValueRow[]
  problems: { line: number; message: string }[]
} {
  const rows: KeyValueRow[] = []
  const problems: { line: number; message: string }[] = []
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = index + 1
    let body = raw.trim()
    if (body === '') continue
    let enabled = true
    if (body.startsWith('//')) {
      enabled = false
      body = body.slice(2).trim()
      if (body === '') continue
    }
    const colon = body.indexOf(':')
    if (colon === -1) {
      problems.push({ line, message: `Line ${line} has no colon; write it as key: value.` })
      continue
    }
    const key = body.slice(0, colon).trim()
    if (key === '') {
      problems.push({ line, message: `Line ${line} has no key before its colon.` })
      continue
    }
    rows.push({ id: rowId(), key, value: body.slice(colon + 1).trim(), enabled })
  }
  return { rows, problems }
}

/** What is wrong with each row, by id: a key twice, a refused key, a value with no key. */
export function rowProblems(
  rows: readonly KeyValueRow[],
  validateKey?: ((key: string) => string | undefined) | undefined,
): Map<string, string> {
  const problems = new Map<string, string>()
  const seen = new Map<string, number>()
  for (const row of rows) {
    if (row.key === '') {
      if (row.value !== '') problems.set(row.id, 'This row needs a key.')
      continue
    }
    const refused = validateKey?.(row.key)
    if (refused !== undefined) {
      problems.set(row.id, refused)
      continue
    }
    if (!row.enabled) continue
    const count = (seen.get(row.key) ?? 0) + 1
    seen.set(row.key, count)
    if (count > 1)
      problems.set(
        row.id,
        `${row.key} appears ${count === 2 ? 'twice' : `${count} times`}; ${count === 2 ? 'both' : 'all'} are sent.`,
      )
  }
  return problems
}

/**
 * Key and value boxes: the height and type of Kumo's small input, in the
 * data face (12 px). Ground and ring colour are added per use, never
 * appended over one already here — of two utilities for one property, the
 * stylesheet's order wins, not the class list's.
 */
const BOX =
  'h-7 min-w-0 rounded-md px-2 font-mono text-[12px] ring outline-none placeholder:font-sans placeholder:text-kumo-inactive focus:ring-kumo-focus'
/** The add line's boxes: the same shape, quieter, since nothing is in them yet. */
const ADDING = 'bg-transparent text-kumo-default ring-kumo-hairline'
/** A row's box at rest. */
const FILLED = 'bg-kumo-control ring-kumo-line'

export function KeyValueEditor({
  label,
  rows,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  suggestKeys,
  validateKey,
  allowDisable = false,
  testId,
}: {
  /** "Headers", "Attributes", "Metadata". */
  label: string
  rows: readonly KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
  keyPlaceholder?: string | undefined
  valuePlaceholder?: string | undefined
  /** Keys offered as you type one (common headers, attribute names already in use). */
  suggestKeys?: readonly string[] | undefined
  /** Why a key is refused, or `undefined` when it is fine. */
  validateKey?: ((key: string) => string | undefined) | undefined
  /** The switch that keeps a row without sending it (headers yes, metadata no). */
  allowDisable?: boolean | undefined
  testId?: string | undefined
}) {
  const ids = testId ?? 'key-value'
  const [bulk, setBulk] = useState<{
    text: string
    problems: { line: number; message: string }[]
  } | null>(null)
  const problems = rowProblems(rows, validateKey)
  const counted = rows.filter((row) => row.enabled && row.key !== '').length
  // The input a new row hands focus to, once it exists.
  const [focus, setFocus] = useState<{ id: string; field: 'key' | 'value' } | null>(null)
  const inputs = useRef(new Map<string, HTMLInputElement>())
  useEffect(() => {
    if (!focus) return
    const input = inputs.current.get(`${focus.id}:${focus.field}`)
    if (!input) return
    input.focus()
    const end = input.value.length
    input.setSelectionRange(end, end)
    setFocus(null)
  }, [focus])

  const update = (id: string, patch: Partial<KeyValueRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const remove = (id: string) => onChange(rows.filter((row) => row.id !== id))
  const add = (field: 'key' | 'value', text: string) => {
    const row: KeyValueRow = {
      id: rowId(),
      key: field === 'key' ? text : '',
      value: field === 'value' ? text : '',
      enabled: true,
    }
    onChange([...rows, row])
    setFocus({ id: row.id, field })
  }

  const openBulk = () => setBulk({ text: rowsToText(rows), problems: [] })
  const editBulk = (text: string) => {
    const read = textToRows(text)
    // Ids carry over by position, so a row keeps its identity through a
    // round trip and the caller's keys do not churn on every keystroke.
    onChange(read.rows.map((row, index) => ({ ...row, id: rows[index]?.id ?? row.id })))
    setBulk({ text, problems: read.problems })
  }

  return (
    <section className="flex min-w-0 flex-col gap-1.5" aria-label={label} data-testid={ids}>
      <div className="flex min-h-7 items-center gap-2">
        <h3 className="m-0 text-[12px] font-normal text-kumo-subtle">
          {label}
          {counted > 0 && ` · ${counted}`}
        </h3>
        <span className="ml-auto">
          {bulk ? (
            <Tooltip
              content={
                bulk.problems.length > 0
                  ? `Fix line ${bulk.problems[0]?.line} first, or it would be lost`
                  : 'Back to one row per pair'
              }
              render={
                <span className="inline-flex">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={bulk.problems.length > 0}
                    onClick={() => setBulk(null)}
                    data-testid={`${ids}-rows`}
                  >
                    Rows
                  </Button>
                </span>
              }
            />
          ) : (
            <Tooltip
              content="Edit every pair as text, one per line"
              render={
                <Button variant="ghost" size="sm" onClick={openBulk} data-testid={`${ids}-bulk`}>
                  Bulk edit
                </Button>
              }
            />
          )}
        </span>
      </div>
      {bulk ? (
        <div className="flex flex-col gap-1">
          <textarea
            value={bulk.text}
            onChange={(event) => editBulk(event.target.value)}
            rows={Math.min(14, Math.max(4, bulk.text.split('\n').length + 1))}
            spellCheck={false}
            aria-label={`${label}, one per line`}
            placeholder={`${keyPlaceholder}: ${valuePlaceholder}`}
            className="min-h-0 resize-y rounded-md bg-kumo-control px-2 py-1.5 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line outline-none placeholder:font-sans placeholder:text-kumo-inactive focus:ring-kumo-focus"
            data-testid={`${ids}-text`}
          />
          <p className="m-0 text-[12px] text-kumo-subtle">
            One <span className="font-mono text-[0.9em]">key: value</span> per line;{' '}
            <span className="font-mono text-[0.9em]">{'//'}</span> in front keeps a line without
            sending it.
          </p>
          {bulk.problems.map((problem) => (
            <p
              key={problem.line}
              className="m-0 text-[12px] text-kumo-danger"
              data-testid={`${ids}-text-problem`}
            >
              {problem.message}
            </p>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row) => (
            <Pair
              key={row.id}
              row={row}
              problem={problems.get(row.id)}
              allowDisable={allowDisable}
              keyPlaceholder={keyPlaceholder}
              valuePlaceholder={valuePlaceholder}
              suggestKeys={suggestKeys}
              taken={rows}
              register={(field, input) => {
                const key = `${row.id}:${field}`
                if (input) inputs.current.set(key, input)
                else inputs.current.delete(key)
              }}
              onChange={(patch) => update(row.id, patch)}
              onRemove={() => remove(row.id)}
              testId={ids}
            />
          ))}
          <AddLine
            allowDisable={allowDisable}
            keyPlaceholder={keyPlaceholder}
            valuePlaceholder={valuePlaceholder}
            onAdd={add}
            testId={ids}
          />
        </div>
      )}
    </section>
  )
}

function Pair({
  row,
  problem,
  allowDisable,
  keyPlaceholder,
  valuePlaceholder,
  suggestKeys,
  taken,
  register,
  onChange,
  onRemove,
  testId,
}: {
  row: KeyValueRow
  problem: string | undefined
  allowDisable: boolean
  keyPlaceholder: string
  valuePlaceholder: string
  suggestKeys: readonly string[] | undefined
  taken: readonly KeyValueRow[]
  register: (field: 'key' | 'value', input: HTMLInputElement | null) => void
  onChange: (patch: Partial<KeyValueRow>) => void
  onRemove: () => void
  testId: string
}) {
  const keyRef = useRef<HTMLInputElement | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const problemId = useId()
  const typed = row.key.toLowerCase()
  const used = new Set(taken.map((item) => item.key.toLowerCase()))
  const matches = (suggestKeys ?? [])
    .filter(
      (key) =>
        key.toLowerCase().startsWith(typed) &&
        key.toLowerCase() !== typed &&
        !used.has(key.toLowerCase()),
    )
    .slice(0, 8)
  return (
    <div className="flex flex-col gap-0.5" data-testid={`${testId}-row`}>
      <div className="flex items-center gap-1.5">
        {allowDisable && (
          <Checkbox
            checked={row.enabled}
            onCheckedChange={(checked) => onChange({ enabled: checked === true })}
            aria-label={`Send ${row.key || 'this row'}`}
          />
        )}
        <input
          ref={(input) => {
            keyRef.current = input
            register('key', input)
          }}
          value={row.key}
          onChange={(event) => onChange({ key: event.target.value })}
          onFocus={() => setSuggesting(true)}
          onBlur={() => setSuggesting(false)}
          onKeyDown={(event) => {
            const first = matches[0]
            if (event.key === 'Tab' && !event.shiftKey && suggesting && first) {
              event.preventDefault()
              onChange({ key: first })
              setSuggesting(false)
            } else if (event.key === 'Escape' && suggesting && matches.length > 0) {
              event.preventDefault()
              event.stopPropagation()
              setSuggesting(false)
            }
          }}
          placeholder={keyPlaceholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${row.key || 'New'} key`}
          aria-invalid={problem !== undefined || undefined}
          aria-describedby={problem ? problemId : undefined}
          className={`${BOX} w-[38%] shrink-0 bg-kumo-control ${problem ? 'ring-kumo-danger' : 'ring-kumo-line'} ${row.enabled ? 'text-kumo-default' : 'text-kumo-subtle line-through'}`}
          data-testid={`${testId}-key`}
        />
        <input
          ref={(input) => register('value', input)}
          value={row.value}
          onChange={(event) => onChange({ value: event.target.value })}
          placeholder={valuePlaceholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${row.key || 'New'} value`}
          className={`${BOX} ${FILLED} flex-1 ${row.enabled ? 'text-kumo-default' : 'text-kumo-subtle'}`}
          data-testid={`${testId}-value`}
        />
        <Tooltip
          content="Remove this row"
          render={
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<XIcon />}
              aria-label={`Remove ${row.key || 'this row'}`}
              onClick={onRemove}
              data-testid={`${testId}-remove`}
            />
          }
        />
      </div>
      {problem && (
        <p
          id={problemId}
          className={`m-0 text-[12px] leading-5 text-kumo-danger ${allowDisable ? 'pl-6' : ''}`}
          data-testid={`${testId}-problem`}
        >
          {problem}
        </p>
      )}
      {suggesting && matches.length > 0 && (
        <Completions anchor={keyRef} testId={`${testId}-suggestions`}>
          {matches.map((key) => (
            <Completion
              key={key}
              label={key}
              detail=""
              onPick={() => {
                onChange({ key })
                setSuggesting(false)
              }}
            />
          ))}
        </Completions>
      )}
    </div>
  )
}

/**
 * The line under the rows that adds one: typing into either box is adding a
 * row, and focus follows into it. Never disabled, never hidden.
 */
function AddLine({
  allowDisable,
  keyPlaceholder,
  valuePlaceholder,
  onAdd,
  testId,
}: {
  allowDisable: boolean
  keyPlaceholder: string
  valuePlaceholder: string
  onAdd: (field: 'key' | 'value', text: string) => void
  testId: string
}) {
  return (
    <div className="flex items-center gap-1.5" data-testid={`${testId}-add`}>
      {allowDisable && <span className="w-4 shrink-0" aria-hidden />}
      <input
        value=""
        onChange={(event) => event.target.value !== '' && onAdd('key', event.target.value)}
        placeholder={`Add a ${keyPlaceholder}`}
        spellCheck={false}
        autoComplete="off"
        aria-label={`Add a ${keyPlaceholder}`}
        className={`${BOX} ${ADDING} w-[38%] shrink-0`}
        data-testid={`${testId}-add-key`}
      />
      <input
        value=""
        onChange={(event) => event.target.value !== '' && onAdd('value', event.target.value)}
        placeholder={valuePlaceholder}
        spellCheck={false}
        autoComplete="off"
        aria-label={`Add a ${valuePlaceholder}`}
        className={`${BOX} ${ADDING} flex-1`}
        data-testid={`${testId}-add-value`}
      />
      {/* The remove column's width, so the add line's boxes line up with the rows'. */}
      <span className="w-[23px] shrink-0" aria-hidden />
    </div>
  )
}
