// One editor per Firestore type, because a text box per type is the same as
// having no editor at all: it is the type that knows what a good value looks
// like. A number says whether it is an integer or a double, a timestamp
// offers a calendar and says how long ago it was, a reference completes the
// path it is pointing at, a geopoint is two numbers rather than one string
// with a comma in it, and bytes say how many they are.

import { Button, DatePicker, Switch, Tooltip } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, ArrowsInSimpleIcon, ArrowsOutSimpleIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { type DraftNode, numberForm } from '../draft'
import { collectionsQuery, documentIdsQuery } from '../queries'
import { relativeTime } from '../value'
import { Anchored, Completion, Completions } from './completions'
import { useFieldEditing, useFocusTarget } from './field-context'
import { StripButton } from './strip-button'
import { useWorkbench } from './workbench-context'

export interface EditorProps {
  node: DraftNode
  onChange: (next: DraftNode) => void
  /** What the screen reader calls this value: the field name, or an index. */
  label: string
  invalid: boolean
}

/**
 * The metrics a growing field and the mirror sizing it must agree on, down
 * to the pixel, or the box is the wrong height for its text. One line of
 * it is 28 px, the height every other editor on the line already is.
 */
// `break-word`, not `anywhere`: the two wrap a long token identically, but
// `anywhere` counts those break opportunities towards the min-content
// width, which collapses a content-sized field to a single character.
const WRAP_BOX =
  'min-w-0 px-1.5 py-[5px] font-mono text-[12px] leading-[18px] whitespace-pre-wrap [overflow-wrap:break-word]'

/**
 * The box a line of value lives in.
 *
 * A value used to wear nothing at rest, on the rule that it is text you read
 * far more often than you change. The rule was wrong about what the reader
 * needs to know: a bordered control says "you can type here" before anybody
 * tries one, and a column of bare text says the opposite, so the panel read
 * as a dump of a document rather than an editor of one. Nothing else argued
 * otherwise either — the type menu, the only hint that a value's type can be
 * changed at all, is under the pointer and not on the line.
 *
 * The box costs nothing. A ring is painted with a shadow, so a boxed line is
 * exactly as tall as a bare one; what the old rule was really protecting
 * against was fourteen full-width boxes stacked two pixels apart, and the
 * answer to that is the air between them, which is now six.
 *
 * Focus still has a state of its own, and being wrong still always shows.
 */
function Line({
  invalid,
  lead,
  word,
  children,
}: {
  invalid: boolean
  /** A label the value reads on from, inside the box: `lat`, `lng`. */
  lead?: ReactNode
  /** The value's own word, inside the box at its end. */
  word?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className={`flex min-w-0 flex-1 items-start rounded-md bg-kumo-control ring ${
        invalid ? 'ring-kumo-danger' : 'ring-kumo-line focus-within:ring-kumo-focus'
      }`}
    >
      {lead}
      {children}
      {word}
    </div>
  )
}

/** One line of value, inside the box: the box carries the ground and the ring. */
const INPUT =
  'h-8 min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[12px] text-kumo-default outline-none'

/**
 * A value that can be any length wraps rather than running off the end of
 * its line. A console is for reading a document before it is for editing
 * one, and a value cut short at the panel's edge is a value the panel
 * failed to show — a URL loses its path, which is the half that says
 * anything. An `input` cannot wrap at all, which is why this is a
 * `textarea` that happens to hold one line most of the time.
 */
const WRAP_TEXT = `${WRAP_BOX} col-start-1 row-start-1 resize-none overflow-hidden bg-transparent text-kumo-default outline-none`

/**
 * A value followed by a word of its own — `double`, `ref`, `18 d ago`. The
 * word used to sit outside the control, which meant the control had to be
 * content-wide to keep the two together, which meant a column of boxes in
 * eight different widths. Inside the box, at its end, the word stays beside
 * its value and the column stays a column.
 */
const WORD = 'flex h-8 shrink-0 items-center pr-1.5 pl-1 font-mono text-[11px] text-kumo-subtle'

/** What a value reads on from, where it takes two of them to mean anything. */
const LEAD = 'flex h-8 shrink-0 items-center pl-2 font-mono text-[11px] text-kumo-inactive'

/**
 * A field that grows with what is in it, in every browser. An invisible
 * copy of the text sets the height of the grid cell and the field lies on
 * top of it. `field-sizing: content` says this in one word but not
 * everywhere yet, and a value cut short in Firefox is still cut short.
 */
export function Grows({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 flex-1">
      <span className={`${WRAP_BOX} invisible col-start-1 row-start-1`} aria-hidden="true">
        {`${text} `}
      </span>
      {children}
    </div>
  )
}

/**
 * Whether this value is a region of text rather than a line of it. A region
 * cannot share the line with its name, so the row puts it underneath at the
 * full width of the panel.
 */
export function valueIsRegion(node: DraftNode): boolean {
  if (node.type === 'vector') return true
  if (node.type !== 'string') return false
  return node.wide === true || node.text.includes('\n')
}

/**
 * A region says how much room there is the same way a line does, in the
 * same ink: the two are one column of boxes down the panel, and the only
 * difference between them is how many lines they hold.
 */
export function valueAreaClass(invalid: boolean): string {
  return `w-full resize-y rounded-md bg-kumo-control px-2 py-1 font-mono text-[12px] leading-5 text-kumo-default ring outline-none focus:ring-kumo-focus ${
    invalid ? 'ring-kumo-danger' : 'ring-kumo-line'
  }`
}

const NOTE = 'px-1.5 pt-0.5 font-mono text-[11px] text-kumo-subtle'

export function ValueEditor(props: EditorProps) {
  switch (props.node.type) {
    case 'boolean':
      return <BooleanEditor {...props} />
    case 'null':
      return <NullEditor />
    case 'number':
      return <NumberEditor {...props} />
    case 'timestamp':
      return <TimestampEditor {...props} />
    case 'reference':
      return <ReferenceEditor {...props} />
    case 'geopoint':
      return <GeopointEditor {...props} />
    case 'bytes':
      return <BytesEditor {...props} />
    case 'vector':
      return <VectorEditor {...props} />
    default:
      return <StringEditor {...props} />
  }
}

/** Enter in a one-line value means "done with this one", not "save". */
function onEnterNext(next: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    next()
  }
}

function StringEditor({ node, onChange, label, invalid }: EditorProps) {
  const { next } = useFieldEditing()
  const lines = node.text.split('\n').length
  // A string with a newline in it cannot be shown on a line without losing
  // the newline, so that one opens as a box whatever the setting says.
  const box = valueIsRegion(node)
  const line = useFocusTarget<HTMLTextAreaElement>(node.id)
  const area = useFocusTarget<HTMLTextAreaElement>(node.id)
  if (box)
    return (
      <textarea
        ref={area}
        value={node.text}
        onChange={(event) => onChange({ ...node, text: event.target.value })}
        rows={Math.min(10, Math.max(2, lines))}
        spellCheck={false}
        className={valueAreaClass(invalid)}
        aria-label={`${label} value`}
      />
    )
  return (
    <Line invalid={invalid}>
      <Grows text={node.text}>
        <textarea
          ref={line}
          rows={1}
          value={node.text}
          onChange={(event) => onChange({ ...node, text: event.target.value })}
          // Enter still means "done with this one"; a newline — which
          // turns the value into a region below the line — is Shift.
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            next()
          }}
          spellCheck={false}
          placeholder={'""'}
          className={`${WRAP_TEXT} placeholder:text-kumo-inactive`}
          aria-label={`${label} value`}
        />
      </Grows>
    </Line>
  )
}

/**
 * The control a type has that is not its value — more room for a string, a
 * calendar for a timestamp, a way through for a reference. It belongs to the
 * row's strip rather than to the editor: a control drawn only on hover has no
 * business holding a column of the line open at rest.
 */
export function ValueControls({ node, onChange, label }: Omit<EditorProps, 'invalid'>) {
  switch (node.type) {
    case 'string': {
      // A string with a newline in it has nowhere to go but a box.
      if (valueIsRegion(node) && node.text.includes('\n')) return null
      const box = valueIsRegion(node)
      return (
        <Tooltip
          content={box ? 'One line' : 'More room'}
          render={
            <StripButton
              label={box ? `${label} on one line` : `${label} in a box`}
              icon={box ? <ArrowsInSimpleIcon size={14} /> : <ArrowsOutSimpleIcon size={14} />}
              on={box}
              onClick={() => onChange({ ...node, wide: !box })}
            />
          }
        />
      )
    }
    case 'number': {
      const form = numberForm(node)
      return (
        <NumberForm
          forced={form.forced}
          integer={form.integer}
          label={label}
          onPick={() => onChange({ ...node, integer: !form.integer })}
        />
      )
    }
    case 'reference':
      return <OpenReference node={node} label={label} />
    default:
      return null
  }
}

function NumberEditor({ node, onChange, label, invalid }: EditorProps) {
  const { next } = useFieldEditing()
  const ref = useFocusTarget<HTMLInputElement>(node.id)
  const form = numberForm(node)
  return (
    <Line
      invalid={invalid}
      word={
        /* Firestore stores an integer and a double as different types, and
           `3` is how both of them are written. Nothing in the text can say
           which this is, so the editor has to — and did not: every double
           that read whole came back an integer the moment it was touched.
           Saying it is this word's job; changing it is the strip's, like
           every other control a row has. */
        <span className={WORD} data-testid="number-form">
          {form.integer ? 'integer' : 'double'}
        </span>
      }
    >
      <input
        ref={ref}
        value={node.text}
        onChange={(event) => onChange({ ...node, text: event.target.value })}
        onKeyDown={onEnterNext(next)}
        spellCheck={false}
        inputMode="decimal"
        className={INPUT}
        aria-label={`${label} value`}
      />
    </Line>
  )
}

/**
 * Integer or double, where the strip is. It is drawn as the word in the box
 * it covers, so pointing at the row lights that word up rather than putting
 * something else in its place.
 *
 * It used to be the word: a button at the end of the value, which worked
 * only while the end of the value was somewhere the strip did not reach.
 * Once every value wore a box the two wanted the same pixels, and the strip
 * won — a control nothing can click is worse than one that is only there
 * under the pointer, which is where this row keeps its controls anyway.
 */
function NumberForm({
  forced,
  integer,
  label,
  onPick,
}: {
  forced: boolean
  integer: boolean
  label: string
  onPick: () => void
}) {
  return (
    <StripButton
      label={`${label} is ${integer ? 'an integer' : 'a double'}`}
      disabled={forced}
      onClick={onPick}
      title={
        forced
          ? 'A number with a fraction is always a double'
          : 'Firestore stores integers and doubles as different types'
      }
    >
      {integer ? 'integer' : 'double'}
    </StripButton>
  )
}

function BooleanEditor({ node, onChange, label }: EditorProps) {
  return (
    <div className="flex h-8 min-w-0 flex-1 items-center">
      <Switch
        variant="neutral"
        size="sm"
        checked={node.text === 'true'}
        onClick={() => onChange({ ...node, text: node.text === 'true' ? 'false' : 'true' })}
        aria-label={`${label} value`}
      />
      <span className="ml-2 font-mono text-[12px] text-kumo-subtle">{node.text}</span>
    </div>
  )
}

/**
 * The one value with nothing to type into. It keeps the line's height and
 * not its box: a box that cannot be typed in is a worse lie than no box.
 */
function NullEditor() {
  return (
    <span className="flex h-8 min-w-0 flex-1 items-center px-1.5 font-mono text-[12px] text-kumo-inactive">
      null
    </span>
  )
}

/**
 * A timestamp edits as the instant it is, and picks as the day and time a
 * person thinks in.
 *
 * The calendar used to be a button in the row's strip — drawn on hover,
 * at the far end of the line, for a value at the near end. A control
 * nobody can see is a control nobody finds, which is the third time that
 * has been true in this panel. The field opens it instead, the way the
 * reference field opens its completions: one affordance, on the value it
 * belongs to, the moment you touch it.
 *
 * The text stays the truth. A picker speaks in days and seconds and the
 * stored value is an instant to the millisecond, so what is typed always
 * wins and the panel only ever hands it a new instant.
 */
function TimestampEditor({ node, onChange, label, invalid }: EditorProps) {
  const { next } = useFieldEditing()
  const ref = useFocusTarget<HTMLInputElement>(node.id)
  const [open, setOpen] = useState(false)
  const when = new Date(node.text.trim())
  const known = !Number.isNaN(when.getTime())
  // A field that does not parse yet still has to pick from somewhere.
  const base = known ? when : new Date()
  const set = (moment: Date) => onChange({ ...node, text: moment.toISOString() })

  return (
    <div
      className="min-w-0 flex-1"
      // Shutting is about focus leaving the field *and* its panel, not
      // leaving the field. The calendar takes focus onto the day it
      // selects, so a panel that shut on the field's own blur shut on the
      // first day pressed, and a time could never be set in it. React
      // sends a portal's events up its own tree, so this hears both; the
      // panel is not a DOM descendant, which is why it is named here
      // rather than contained.
      onBlur={(event) => {
        const going = event.relatedTarget
        if (
          going &&
          (event.currentTarget.contains(going) || going.closest(`[data-testid="${PANEL}"]`))
        )
          return
        setOpen(false)
      }}
    >
      <Line
        invalid={invalid}
        word={known ? <span className={WORD}>{relativeTime(when.toISOString())}</span> : undefined}
      >
        <input
          ref={ref}
          value={node.text}
          onChange={(event) => onChange({ ...node, text: event.target.value })}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false)
            else if (event.key === 'Enter') {
              event.preventDefault()
              next()
            }
          }}
          spellCheck={false}
          className={INPUT}
          aria-label={`${label} value`}
        />
      </Line>
      {open && (
        <Anchored anchor={ref} testId={PANEL} width="content" room={360}>
          <div className="grid gap-2 p-2">
            <DatePicker
              mode="single"
              selected={known ? when : undefined}
              // Or it opens on this month and the value's own month is
              // somewhere behind an arrow.
              defaultMonth={base}
              onChange={(day) => {
                if (day) set(withDay(base, day))
              }}
            />
            <div className="flex items-center gap-2 border-t border-kumo-line pt-2">
              <input
                type="time"
                step="1"
                value={timeOf(base)}
                onChange={(event) => set(withTime(base, event.target.value))}
                className="h-8 rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus"
                aria-label={`${label} time of day`}
              />
              <Button variant="secondary" size="sm" onClick={() => set(new Date())}>
                Now
              </Button>
              <span className="ml-auto font-mono text-[11px] text-kumo-subtle">{timeZone()}</span>
            </div>
          </div>
        </Anchored>
      )}
    </div>
  )
}

/** The same instant on another day; the time of day it already had. */
function withDay(base: Date, day: Date): Date {
  const next = new Date(base)
  next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate())
  return next
}

/** The same day at another time; the milliseconds it already had. */
function withTime(base: Date, value: string): Date {
  const [hours = 0, minutes = 0, seconds = 0] = value.split(':').map(Number)
  const next = new Date(base)
  next.setHours(hours, minutes, seconds)
  return next
}

function timeOf(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** The panel's name, which is also how a blur tells inside from outside. */
const PANEL = 'timestamp-picker'

/** The browser's own zone, named, because the picker works in it. */
function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function ReferenceEditor({ node, onChange, label, invalid }: EditorProps) {
  const workbench = useWorkbench()
  const { next } = useFieldEditing()
  const ref = useFocusTarget<HTMLTextAreaElement>(node.id)
  const [open, setOpen] = useState(false)

  const path = node.text.replace(/^\/+/, '')
  const segments = path.split('/')
  const typed = segments.at(-1) ?? ''
  const parent = segments.slice(0, -1).join('/')
  // An even number of segments before the one being typed means a document
  // path, so what comes next is a collection; an odd number means we are
  // inside a collection and what comes next is one of its documents.
  const wantsCollection = (segments.length - 1) % 2 === 0

  const collections = useQuery({
    ...collectionsQuery(workbench.ownerScope, parent),
    enabled: open && wantsCollection,
  })
  const documents = useQuery({
    ...documentIdsQuery(workbench.ownerScope, parent, typed),
    enabled: open && !wantsCollection && parent !== '',
  })
  const source = wantsCollection ? collections.data : documents.data
  const matches = (source ?? []).filter((id) => id.startsWith(typed) && id !== typed).slice(0, 8)

  const take = (id: string) => {
    const head = parent ? `${parent}/` : ''
    // A collection is never the destination, so it leaves the slash typed.
    onChange({ ...node, text: `${head}${id}${wantsCollection ? '/' : ''}` })
    ref.current?.focus()
  }

  return (
    <div className="min-w-0 flex-1">
      <Line
        invalid={invalid}
        /* A path is the one value that reads exactly like a string, so
           this type keeps a word the way a double does. */
        word={node.text.trim() === '' ? undefined : <span className={WORD}>ref</span>}
      >
        <Grows text={node.text}>
          <textarea
            ref={ref}
            rows={1}
            value={node.text}
            onChange={(event) => onChange({ ...node, text: event.target.value })}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={(event) => {
              const first = matches[0]
              if (event.key === 'Tab' && first) {
                event.preventDefault()
                take(first)
              } else if (event.key === 'Enter') {
                // A path has no newline in it, whatever is pressed.
                event.preventDefault()
                next()
              } else if (event.key === 'Escape') setOpen(false)
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder="users/u_9f3k2"
            className={`${WRAP_TEXT} placeholder:font-sans placeholder:text-kumo-inactive`}
            aria-label={`${label} value`}
          />
        </Grows>
      </Line>
      {open && matches.length > 0 && (
        <Completions anchor={ref} testId="reference-completions">
          {matches.map((id) => (
            <Completion
              key={id}
              label={id}
              detail={wantsCollection ? 'collection' : 'document'}
              onPick={() => take(id)}
            />
          ))}
        </Completions>
      )}
    </div>
  )
}

function OpenReference({ node, label }: Omit<EditorProps, 'invalid' | 'onChange'>) {
  const { onOpenReference } = useFieldEditing()
  return (
    <Tooltip
      content="Open the referenced document"
      render={
        <StripButton
          label={`Open ${label}`}
          icon={<ArrowSquareOutIcon size={14} />}
          onClick={() => onOpenReference(node.text)}
        />
      }
    />
  )
}

function GeopointEditor({ node, onChange, label, invalid }: EditorProps) {
  const { next } = useFieldEditing()
  const ref = useFocusTarget<HTMLInputElement>(node.id)
  const comma = node.text.indexOf(',')
  const latitude = comma === -1 ? node.text : node.text.slice(0, comma)
  const longitude = comma === -1 ? '' : node.text.slice(comma + 1).trim()
  const set = (lat: string, lng: string) => onChange({ ...node, text: `${lat}, ${lng}` })
  return (
    <div className="flex min-w-0 flex-1 items-start gap-1">
      <Line invalid={invalid} lead={<span className={LEAD}>lat</span>}>
        <input
          ref={ref}
          value={latitude}
          onChange={(event) => set(event.target.value.replace(/,/g, ''), longitude)}
          onKeyDown={onEnterNext(next)}
          spellCheck={false}
          inputMode="decimal"
          className={INPUT}
          aria-label={`${label} value`}
        />
      </Line>
      <Line invalid={invalid} lead={<span className={LEAD}>lng</span>}>
        <input
          value={longitude}
          onChange={(event) => set(latitude, event.target.value.replace(/,/g, ''))}
          onKeyDown={onEnterNext(next)}
          spellCheck={false}
          inputMode="decimal"
          className={INPUT}
          aria-label={`${label} longitude`}
        />
      </Line>
    </div>
  )
}

function BytesEditor({ node, onChange, label, invalid }: EditorProps) {
  const { next } = useFieldEditing()
  const ref = useFocusTarget<HTMLTextAreaElement>(node.id)
  const text = node.text.trim()
  return (
    <div className="min-w-0 flex-1">
      <Line invalid={invalid}>
        <Grows text={node.text}>
          <textarea
            ref={ref}
            rows={1}
            value={node.text}
            onChange={(event) => onChange({ ...node, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              next()
            }}
            spellCheck={false}
            placeholder="base64"
            className={`${WRAP_TEXT} placeholder:font-sans placeholder:text-kumo-inactive`}
            aria-label={`${label} value`}
          />
        </Grows>
      </Line>
      {/* A word goes inside the box — `double`, `ref`, `18 d ago`. This is
          not a word but a note, and an unbounded one: the decoded text can
          be forty characters, which is width the bytes themselves need. */}
      {text !== '' && !invalid && (
        <div className={NOTE}>
          {byteLength(text)} bytes
          {readable(text) === undefined ? '' : ` · ${readable(text)}`}
        </div>
      )}
    </div>
  )
}

function byteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/** Bytes that happen to be text, shown as text — it usually is. */
function readable(base64: string): string | undefined {
  try {
    const decoded = atob(base64)
    // oxlint-disable-next-line no-control-regex -- the point is to reject them
    if (decoded === '' || /[\u0000-\u0008\u000e-\u001f]/.test(decoded)) return undefined
    return decoded.length > 40 ? `${decoded.slice(0, 40)}…` : decoded
  } catch {
    return undefined
  }
}

function VectorEditor({ node, onChange, label, invalid }: EditorProps) {
  const area = useFocusTarget<HTMLTextAreaElement>(node.id)
  let dimensions: number | undefined
  try {
    const parsed: unknown = JSON.parse(node.text)
    if (Array.isArray(parsed)) dimensions = parsed.length
  } catch {
    dimensions = undefined
  }
  return (
    <div>
      <textarea
        ref={area}
        value={node.text}
        onChange={(event) => onChange({ ...node, text: event.target.value })}
        rows={Math.min(8, Math.max(2, node.text.split('\n').length))}
        spellCheck={false}
        className={valueAreaClass(invalid)}
        aria-label={`${label} value`}
      />
      {dimensions !== undefined && (
        <div className={NOTE}>
          {dimensions} dimension{dimensions === 1 ? '' : 's'}
        </div>
      )}
    </div>
  )
}
