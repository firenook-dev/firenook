// One row, and it recurses.
//
// A field of a document, an entry of a map and an element of an array are
// the same object — a name (or an index), a type, a value — so they are one
// component. That is what lets the panel edit a nested structure at all:
// before this, a map was a JSON textarea, which meant the one case a form
// is better than raw JSON at was the one case the form gave up on.

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
import { ValueEditor } from './value-editors'

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

  const addChild = () => {
    const child = emptyNode('', 'string')
    onChange({ ...node, children: [...node.children, child] })
    setOpen(true)
    editing.takeFocus(node.type === 'map' ? `${child.id}:name` : child.id)
  }

  if (node.removed === true)
    return (
      <div
        className="flex items-center gap-2 px-1.5 opacity-70"
        data-testid="field-row"
        data-removed=""
      >
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
    <div className="group/row grid gap-0.5" data-testid="field-row">
      <div className="flex items-center gap-1 pr-1.5 pl-0.5">
        {container && (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded text-kumo-subtle hover:bg-kumo-tint"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
          >
            {open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
          </button>
        )}
        {named ? (
          <NameInput node={node} onChange={onChange} invalid={problem?.name !== undefined} />
        ) : (
          <span className="w-6 shrink-0 pl-1.5 font-mono text-[12px] text-kumo-subtle tabular-nums">
            {index}
          </span>
        )}
        {/* Which fields the footer's count is counting. Save is the row's
            own accent, and this is what it is about to write. */}
        {unsaved && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-kumo-brand"
            title="Unsaved"
            data-testid="unsaved-mark"
          />
        )}
        {!named && (
          <span className={`flex items-center ${ACCESSORY}`}>
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
          </span>
        )}
        {!named && <span className="min-w-0 flex-1" />}
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                type="button"
                className="group flex h-5 shrink-0 items-center rounded px-0.5 hover:bg-kumo-tint"
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
            <span className={ACCESSORY}>
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
            </span>
            {/* Rows are the point; JSON is the escape hatch, so it waits
                to be asked for unless it is already in use. */}
            <span className={node.raw === true ? 'shrink-0' : ACCESSORY}>
              <Tooltip
                content={node.raw === true ? 'Back to rows' : 'Edit as JSON'}
                render={
                  <Button
                    variant={node.raw === true ? 'secondary' : 'ghost'}
                    size="xs"
                    shape="square"
                    icon={<BracketsCurlyIcon />}
                    aria-label={`Edit ${label} as JSON`}
                    onClick={() => onChange({ ...node, raw: node.raw !== true })}
                  />
                }
              />
            </span>
          </>
        )}
        <span className={ACCESSORY}>
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
      {/* A rename is a delete and a set in one write, and only in this
          document: Firestore has no rename and no schema, so the rest of the
          collection keeps the old name. Saying so costs one line and saves
          someone an afternoon. */}
      {renamedFrom !== undefined && (
        <span className="px-1.5 text-[11px] text-kumo-subtle">
          Renaming <span className="font-mono">{renamedFrom}</span> here changes this document only.
        </span>
      )}
      {container ? (
        node.raw === true ? (
          <textarea
            value={node.text}
            onChange={(event) => onChange({ ...node, text: event.target.value })}
            rows={Math.min(14, Math.max(3, node.text.split('\n').length))}
            spellCheck={false}
            className={`w-full resize-y rounded-md bg-kumo-control px-2 py-1 font-mono text-[12px] leading-5 text-kumo-default ring outline-none focus:ring-kumo-focus ${
              problem?.value === undefined ? 'ring-kumo-line' : 'ring-kumo-danger'
            }`}
            aria-label={`${label} value`}
          />
        ) : open ? (
          node.children.length === 0 ? (
            <span className="px-1.5 font-mono text-[12px] text-kumo-inactive">
              {node.type === 'map' ? '{}' : '[]'}
            </span>
          ) : (
            <div className="ml-2 grid gap-2.5 border-l border-kumo-line pl-2">
              <FieldRows
                nodes={node.children}
                named={node.type === 'map'}
                onChange={(children) => onChange({ ...node, children })}
              />
            </div>
          )
        ) : (
          <span className="px-1.5 font-mono text-[12px] text-kumo-subtle">{summary(node)}</span>
        )
      ) : (
        <ValueEditor
          node={node}
          onChange={onChange}
          label={label}
          invalid={problem?.value !== undefined}
        />
      )}
      {problem?.value !== undefined && (
        <span className="px-1.5 text-[12px] text-kumo-danger">{problem.value}</span>
      )}
      {problem?.name !== undefined && (
        <span className="px-1.5 text-[12px] text-kumo-danger">{problem.name}</span>
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
 * rest — this is a label you read far more often than you change — takes a
 * ground under the pointer, and keeps the outline for focus alone.
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
      className={`h-6 min-w-0 flex-1 rounded bg-transparent px-1.5 font-mono text-[12px] font-medium text-kumo-default outline-none placeholder:font-sans placeholder:font-normal placeholder:text-kumo-inactive hover:bg-kumo-tint focus:bg-kumo-control focus:ring focus:ring-kumo-focus ${
        invalid ? 'ring ring-kumo-danger' : ''
      }`}
      aria-label={node.name ? `${node.name} name` : 'Field name'}
      data-testid="field-name"
    />
  )
}
