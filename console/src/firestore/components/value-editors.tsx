// One editor per Firestore type, because a text box per type is the same as
// having no editor at all: it is the type that knows what a good value looks
// like. A number says whether it is an integer or a double, a timestamp
// offers a calendar and says how long ago it was, a reference completes the
// path it is pointing at, a geopoint is two numbers rather than one string
// with a comma in it, and bytes say how many they are.

import { Button, Popover, Switch, Tooltip } from '@cloudflare/kumo'
import {
  ArrowSquareOutIcon,
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  CalendarBlankIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { type DraftNode, numberForm } from '../draft'
import { collectionsQuery, documentIdsQuery } from '../queries'
import { relativeTime } from '../value'
import { Completion, Completions } from './completions'
import { useFieldEditing, useFocusTarget } from './field-context'
import { useWorkbench } from './workbench-context'

export interface EditorProps {
  node: DraftNode
  onChange: (next: DraftNode) => void
  /** What the screen reader calls this value: the field name, or an index. */
  label: string
  invalid: boolean
}

/** The chrome every value wears, so one row never looks louder than the next. */
export function valueInputClass(invalid: boolean): string {
  return `h-7 w-full min-w-0 rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring outline-none focus:ring-kumo-focus ${
    invalid ? 'ring-kumo-danger' : 'ring-kumo-line'
  }`
}

const NOTE = 'mt-0.5 font-mono text-[11px] text-kumo-subtle'

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
  const box = node.wide === true || lines > 1
  const ref = useFocusTarget<HTMLInputElement>(node.id)
  const area = useFocusTarget<HTMLTextAreaElement>(node.id)
  return (
    <div className="flex items-start gap-1">
      {box ? (
        <textarea
          ref={area}
          value={node.text}
          onChange={(event) => onChange({ ...node, text: event.target.value })}
          rows={Math.min(10, Math.max(2, lines))}
          spellCheck={false}
          className={`w-full resize-y rounded-md bg-kumo-control px-2 py-1 font-mono text-[12px] leading-5 text-kumo-default ring outline-none focus:ring-kumo-focus ${
            invalid ? 'ring-kumo-danger' : 'ring-kumo-line'
          }`}
          aria-label={`${label} value`}
        />
      ) : (
        <input
          ref={ref}
          value={node.text}
          onChange={(event) => onChange({ ...node, text: event.target.value })}
          onKeyDown={onEnterNext(next)}
          spellCheck={false}
          className={valueInputClass(invalid)}
          aria-label={`${label} value`}
        />
      )}
      {(!box || lines === 1) && (
        // A string is the commonest field there is, so the one control it
        // has that is not the value waits to be asked for.
        <span className="shrink-0 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
          <Tooltip
            content={box ? 'One line' : 'More room'}
            render={
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={box ? <ArrowsInSimpleIcon /> : <ArrowsOutSimpleIcon />}
                aria-label={box ? `${label} on one line` : `${label} in a box`}
                onClick={() => onChange({ ...node, wide: !box })}
              />
            }
          />
        </span>
      )}
    </div>
  )
}

function NumberEditor({ node, onChange, label, invalid }: EditorProps) {
  const { next } = useFieldEditing()
  const ref = useFocusTarget<HTMLInputElement>(node.id)
  const form = numberForm(node)
  return (
    <div className="flex items-center gap-1">
      <input
        ref={ref}
        value={node.text}
        onChange={(event) => onChange({ ...node, text: event.target.value })}
        onKeyDown={onEnterNext(next)}
        spellCheck={false}
        inputMode="decimal"
        className={valueInputClass(invalid)}
        aria-label={`${label} value`}
      />
      {/* Firestore stores an integer and a double as different types, and
          `3` is how both of them are written. Nothing in the text can say
          which this is, so the editor has to — and did not: every double
          that read whole came back an integer the moment it was touched. */}
      <button
        type="button"
        disabled={form.forced}
        onClick={() => onChange({ ...node, integer: !form.integer })}
        className="h-7 shrink-0 rounded-md px-1.5 font-mono text-[11px] text-kumo-subtle ring ring-kumo-line outline-none hover:bg-kumo-tint focus-visible:ring-kumo-focus disabled:text-kumo-inactive"
        title={
          form.forced
            ? 'A number with a fraction is always a double'
            : 'Firestore stores integers and doubles as different types'
        }
        aria-label={`${label} is ${form.integer ? 'an integer' : 'a double'}`}
        data-testid="number-form"
      >
        {form.integer ? 'integer' : 'double'}
      </button>
    </div>
  )
}

function BooleanEditor({ node, onChange, label }: EditorProps) {
  return (
    <div className="flex h-7 items-center">
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

function NullEditor() {
  return (
    <span className="flex h-7 items-center font-mono text-[12px] text-kumo-inactive">null</span>
  )
}

function TimestampEditor({ node, onChange, label, invalid }: EditorProps) {
  const { next } = useFieldEditing()
  const ref = useFocusTarget<HTMLInputElement>(node.id)
  const when = new Date(node.text.trim())
  const known = !Number.isNaN(when.getTime())
  return (
    <div>
      <div className="flex items-center gap-1">
        <input
          ref={ref}
          value={node.text}
          onChange={(event) => onChange({ ...node, text: event.target.value })}
          onKeyDown={onEnterNext(next)}
          spellCheck={false}
          className={valueInputClass(invalid)}
          aria-label={`${label} value`}
        />
        <Popover>
          <Popover.Trigger
            render={
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={<CalendarBlankIcon />}
                aria-label={`Pick ${label}`}
              />
            }
          />
          <Popover.Content className="w-[280px]">
            <div className="grid gap-2" data-testid="timestamp-picker">
              <input
                type="datetime-local"
                step="1"
                value={known ? localInput(when) : ''}
                onChange={(event) => {
                  const picked = new Date(event.target.value)
                  if (!Number.isNaN(picked.getTime()))
                    onChange({ ...node, text: picked.toISOString() })
                }}
                className="h-8 w-full rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus"
                aria-label={`${label} date and time`}
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onChange({ ...node, text: new Date().toISOString() })}
                >
                  Now
                </Button>
                <span className="font-mono text-[11px] text-kumo-subtle">{timeZone()}</span>
              </div>
            </div>
          </Popover.Content>
        </Popover>
      </div>
      {known && <div className={NOTE}>{relativeTime(when.toISOString())}</div>}
    </div>
  )
}

/** The browser's own zone, named, because the picker works in it. */
function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function localInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function ReferenceEditor({ node, onChange, label, invalid }: EditorProps) {
  const workbench = useWorkbench()
  const { next, onOpenReference } = useFieldEditing()
  const ref = useFocusTarget<HTMLInputElement>(node.id)
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
    <div>
      <div className="flex items-center gap-1">
        <input
          ref={ref}
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
              event.preventDefault()
              next()
            } else if (event.key === 'Escape') setOpen(false)
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder="users/u_9f3k2"
          className={`${valueInputClass(invalid)} placeholder:font-sans placeholder:text-kumo-inactive`}
          aria-label={`${label} value`}
        />
        <Tooltip
          content="Open the referenced document"
          render={
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              icon={<ArrowSquareOutIcon />}
              aria-label={`Open ${label}`}
              onClick={() => onOpenReference(node.text)}
            />
          }
        />
      </div>
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

function GeopointEditor({ node, onChange, label, invalid }: EditorProps) {
  const { next } = useFieldEditing()
  const ref = useFocusTarget<HTMLInputElement>(node.id)
  const comma = node.text.indexOf(',')
  const latitude = comma === -1 ? node.text : node.text.slice(0, comma)
  const longitude = comma === -1 ? '' : node.text.slice(comma + 1).trim()
  const set = (lat: string, lng: string) => onChange({ ...node, text: `${lat}, ${lng}` })
  const part = `h-full min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[12px] text-kumo-default outline-none`
  const group = `flex h-7 min-w-0 flex-1 items-center rounded-md bg-kumo-control ring focus-within:ring-kumo-focus ${
    invalid ? 'ring-kumo-danger' : 'ring-kumo-line'
  }`
  return (
    <div className="flex items-center gap-1">
      <div className={group}>
        <span className="pl-2 font-mono text-[11px] text-kumo-inactive">lat</span>
        <input
          ref={ref}
          value={latitude}
          onChange={(event) => set(event.target.value.replace(/,/g, ''), longitude)}
          onKeyDown={onEnterNext(next)}
          spellCheck={false}
          inputMode="decimal"
          className={part}
          aria-label={`${label} value`}
        />
      </div>
      <div className={group}>
        <span className="pl-2 font-mono text-[11px] text-kumo-inactive">lng</span>
        <input
          value={longitude}
          onChange={(event) => set(latitude, event.target.value.replace(/,/g, ''))}
          onKeyDown={onEnterNext(next)}
          spellCheck={false}
          inputMode="decimal"
          className={part}
          aria-label={`${label} longitude`}
        />
      </div>
    </div>
  )
}

function BytesEditor({ node, onChange, label, invalid }: EditorProps) {
  const { next } = useFieldEditing()
  const ref = useFocusTarget<HTMLInputElement>(node.id)
  const text = node.text.trim()
  return (
    <div>
      <input
        ref={ref}
        value={node.text}
        onChange={(event) => onChange({ ...node, text: event.target.value })}
        onKeyDown={onEnterNext(next)}
        spellCheck={false}
        placeholder="base64"
        className={`${valueInputClass(invalid)} placeholder:font-sans placeholder:text-kumo-inactive`}
        aria-label={`${label} value`}
      />
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
        className={`w-full resize-y rounded-md bg-kumo-control px-2 py-1 font-mono text-[12px] leading-5 text-kumo-default ring outline-none focus:ring-kumo-focus ${
          invalid ? 'ring-kumo-danger' : 'ring-kumo-line'
        }`}
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
