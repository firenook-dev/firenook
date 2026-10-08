// One row, and it recurses.
//
// A field of a document, an entry of a map and an element of an array are
// the same object — a name (or an index), a type, a value — so they are one
// component. That is what lets the panel edit a nested structure at all:
// before this, a map was a JSON textarea, which meant the one case a form
// is better than raw JSON at was the one case the form gave up on.
//
// A row is one line, and its name and its value are side by side. A document
// is a tree, and a tree is legible only when a node is a line: the two-line
// row made every node a block, and an indent of sixteen pixels says nothing
// against a block forty-seven pixels tall. The one exception earns it — a
// value that is a region of text rather than a line of it goes below.

import { Button, DropdownMenu, Tooltip } from '@cloudflare/kumo'
import {
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BracketsCurlyIcon,
  CaretDownIcon,
  CaretRightIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { useState } from 'react'
import { TypeBadge } from '@/components/kit'
import { type DraftNode, emptyNode, retype } from '../draft'
import { type FirestoreValueType, VALUE_TYPES } from '../value'
import { ACCESSORY, useFieldEditing, useFocusTarget } from './field-context'
import { ValueControls, ValueEditor, valueAreaClass, valueIsRegion } from './value-editors'

/**
 * The caret column. Every row has one, whether or not it holds a caret:
 * giving it only to maps indented them past their own siblings, and past
 * their own children, so the one thing an indent is for — depth — was the
 * one thing it did not say.
 */
const GUTTER = 'flex size-5 shrink-0 items-center justify-center'

export function FieldRows({
  nodes,
  named,
  onChange,
  soft = false,
}: {
  nodes: DraftNode[]
  /** Map entries carry names; array elements are numbered. */
  named: boolean
  onChange: (next: DraftNode[]) => void
  /** A field of the document: removing it marks it, with its undo, until save. */
  soft?: boolean
}) {
  return (
    <>
      {nodes.map((node, index) => (
        <FieldRow
          key={node.id}
          node={node}
          index={index}
          named={named}
          soft={soft}
          onChange={(next) => onChange(nodes.map((item, i) => (i === index ? next : item)))}
          onRemove={() => onChange(nodes.filter((_, i) => i !== index))}
          onMove={(by) => onChange(moved(nodes, index, by))}
        />
      ))}
    </>
  )
}

function moved(nodes: DraftNode[], from: number, by: number): DraftNode[] {
  const to = from + by
  if (to < 0 || to >= nodes.length) return nodes
  const next = [...nodes]
  const [item] = next.splice(from, 1)
  if (item) next.splice(to, 0, item)
  return next
}

function FieldRow({
  node,
  index,
  named,
  soft,
  onChange,
  onRemove,
  onMove,
}: {
  node: DraftNode
  index: number
  named: boolean
  soft: boolean
  onChange: (next: DraftNode) => void
  onRemove: () => void
  onMove: (by: number) => void
}) {
  const editing = useFieldEditing()
  const [open, setOpen] = useState(true)
  const problem = editing.problems.get(node.id)
  const container = node.type === 'map' || node.type === 'array'
  const label = named ? node.name || 'new field' : String(index)
  const unsaved = soft && node.name.trim() !== '' && editing.changed.has(node.name.trim())
  const renamedFrom = node.was !== undefined && node.was !== node.name.trim() ? node.was : undefined
  const raw = container && node.raw === true
  // The line holds a line. Anything taller is a region, and a region needs
  // the width of the panel rather than the stub left over beside a name.
  const region = raw || (!container && valueIsRegion(node))

  const addChild = () => {
    const child = emptyNode('', 'string')
    onChange({ ...node, children: [...node.children, child] })
    setOpen(true)
    editing.takeFocus(node.type === 'map' ? `${child.id}:name` : child.id)
  }

  if (node.removed === true)
    return (
      <div
        className="flex items-center gap-1 rounded-md py-0.5 pr-1 pl-0.5 opacity-70"
        data-testid="field-row"
        data-removed=""
      >
        <span className={GUTTER} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] line-through">
          {node.name}
        </span>
        <span className="shrink-0 text-[11px] text-kumo-subtle">Removed on save</span>
        <Button
          variant="ghost"
          size="xs"
          icon={<ArrowCounterClockwiseIcon />}
          onClick={() => onChange({ ...node, removed: false })}
          aria-label={`Keep ${node.name}`}
        >
          Undo
        </Button>
      </div>
    )

  return (
    <div className="group/row" data-testid="field-row">
      {/* The ground is the line's, not each control's. Hovering a row is how
          you see which field you are on — the thing a column of twenty
          one-line rows has to answer and a column of blocks never had to. */}
      <div className="group/line relative flex min-h-7 items-center gap-1 rounded-md pr-1 pl-0.5 hover:bg-kumo-tint focus-within:bg-kumo-tint">
        <span className={GUTTER}>
          {container && (
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-kumo-subtle hover:bg-kumo-base"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
            >
              {open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
            </button>
          )}
        </span>
        {named ? (
          <NameInput node={node} onChange={onChange} invalid={problem?.name !== undefined} />
        ) : (
          <span className="min-w-4 shrink-0 text-right font-mono text-[12px] text-kumo-subtle tabular-nums">
            {index}
          </span>
        )}
        <span className="-ml-1.5 shrink-0 font-mono text-[12px] text-kumo-inactive">:</span>
        {/* Which fields the footer's count is counting. Save is the row's
            own accent, and this is what it is about to write. */}
        {unsaved && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-kumo-brand"
            title="Unsaved"
            data-testid="unsaved-mark"
          />
        )}
        {container ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-kumo-subtle">
            {raw ? 'json' : summary(node)}
          </span>
        ) : region ? (
          <span className="min-w-0 flex-1" />
        ) : (
          <ValueEditor
            node={node}
            onChange={onChange}
            label={label}
            invalid={problem?.value !== undefined}
          />
        )}
        <span className={ACCESSORY}>
          {!named && (
            <>
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={<ArrowUpIcon />}
                aria-label={`Move ${index} up`}
                onClick={() => onMove(-1)}
              />
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={<ArrowDownIcon />}
                aria-label={`Move ${index} down`}
                onClick={() => onMove(1)}
              />
            </>
          )}
          {!container && <ValueControls node={node} onChange={onChange} label={label} />}
          {/* The type is a control, and the value already says what it is: a
              number is digits, a boolean is a switch, a map counts its own
              entries. Where the text alone is ambiguous the editor says so in
              a word of its own — `double`, `ref`, `lat`, `12 bytes`. */}
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <button
                  type="button"
                  className="group flex h-5 items-center rounded px-0.5 hover:bg-kumo-base"
                  aria-label={`${label} type: ${node.type}`}
                >
                  <TypeBadge type={node.type} menu />
                </button>
              }
            />
            <DropdownMenu.Content>
              <DropdownMenu.RadioGroup
                value={node.type}
                onValueChange={(value) => onChange(retype(node, value as FirestoreValueType))}
              >
                {VALUE_TYPES.map((type) => (
                  <DropdownMenu.RadioItem key={type} value={type} closeOnClick>
                    <span className="font-mono text-[12px]">{type}</span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu>
          {container && (
            <>
              <Tooltip
                content={node.type === 'map' ? 'Add an entry' : 'Add an item'}
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    shape="square"
                    icon={<PlusIcon />}
                    aria-label={`Add to ${label}`}
                    onClick={addChild}
                  />
                }
              />
              {/* Rows are the point; JSON is the escape hatch, so it waits
                  to be asked for. The line says `json` while it is in use. */}
              <Tooltip
                content={raw ? 'Back to rows' : 'Edit as JSON'}
                render={
                  <Button
                    variant={raw ? 'secondary' : 'ghost'}
                    size="xs"
                    shape="square"
                    icon={<BracketsCurlyIcon />}
                    aria-label={`Edit ${label} as JSON`}
                    onClick={() => onChange({ ...node, raw: node.raw !== true })}
                  />
                }
              />
            </>
          )}
          <Tooltip
            content={soft ? 'Remove this field' : 'Remove'}
            render={
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={<TrashIcon />}
                aria-label={`Remove ${label}`}
                onClick={() => (soft ? onChange({ ...node, removed: true }) : onRemove())}
              />
            }
          />
        </span>
      </div>
      {region && (
        <div className="pt-0.5 pb-1 pl-6">
          {raw ? (
            <textarea
              value={node.text}
              onChange={(event) => onChange({ ...node, text: event.target.value })}
              rows={Math.min(14, Math.max(3, node.text.split('\n').length))}
              spellCheck={false}
              className={valueAreaClass(problem?.value !== undefined)}
              aria-label={`${label} value`}
            />
          ) : (
            <ValueEditor
              node={node}
              onChange={onChange}
              label={label}
              invalid={problem?.value !== undefined}
            />
          )}
        </div>
      )}
      {/* A rename is a delete and a set in one write, and only in this
          document: Firestore has no rename and no schema, so the rest of the
          collection keeps the old name. Saying so costs one line and saves
          someone an afternoon. */}
      {renamedFrom !== undefined && (
        <span className="block pl-6 text-[11px] text-kumo-subtle">
          Renaming <span className="font-mono">{renamedFrom}</span> here changes this document only.
        </span>
      )}
      {problem?.value !== undefined && (
        <span className="block pl-6 text-[12px] text-kumo-danger">{problem.value}</span>
      )}
      {problem?.name !== undefined && (
        <span className="block pl-6 text-[12px] text-kumo-danger">{problem.name}</span>
      )}
      {container && !raw && open && node.children.length > 0 && (
        // The step is the gutter's own width, so a child's name lands one
        // column right of its parent's — never, as it did, to the left.
        <div className="ml-2.5 grid gap-0.5 border-l border-kumo-line pl-2.5">
          <FieldRows
            nodes={node.children}
            named={node.type === 'map'}
            onChange={(children) => onChange({ ...node, children })}
          />
        </div>
      )}
    </div>
  )
}

function summary(node: DraftNode): string {
  const count = node.children.filter((child) => child.removed !== true).length
  if (node.type === 'map') return count === 0 ? '{}' : `{ ${count} field${count === 1 ? '' : 's'} }`
  return count === 0 ? '[]' : `[ ${count} item${count === 1 ? '' : 's'} ]`
}

/**
 * The name reads as a name and edits as a field. It wears no chrome at
 * rest — this is a label you read far more often than you change — and it
 * takes the width of what it says, so the value it belongs to can sit
 * beside it instead of on the next line.
 */
function NameInput({
  node,
  onChange,
  invalid,
}: {
  node: DraftNode
  onChange: (next: DraftNode) => void
  invalid: boolean
}) {
  const { takeFocus } = useFieldEditing()
  const ref = useFocusTarget<HTMLInputElement>(`${node.id}:name`)
  return (
    <input
      ref={ref}
      value={node.name}
      onChange={(event) => onChange({ ...node, name: event.target.value })}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        takeFocus(node.id)
      }}
      spellCheck={false}
      autoComplete="off"
      placeholder="name"
      title={node.name}
      // `field-sizing: content` is floored by the `size` attribute, whose
      // default is twenty characters.
      size={1}
      className={`h-6 w-auto max-w-40 min-w-10 shrink-0 rounded bg-transparent px-1.5 font-mono text-[12px] font-medium text-kumo-default outline-none field-sizing-content placeholder:font-sans placeholder:font-normal placeholder:text-kumo-inactive focus:bg-kumo-control focus:ring focus:ring-kumo-focus ${
        invalid ? 'ring ring-kumo-danger' : ''
      }`}
      aria-label={node.name ? `${node.name} name` : 'Field name'}
      data-testid="field-name"
    />
  )
}
