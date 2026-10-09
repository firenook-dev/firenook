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
import { type DraftNode, emptyNode, retype, toggleRaw } from '../draft'
import { type FirestoreValueType, VALUE_TYPES } from '../value'
import { ACCESSORY, useFieldEditing, useFocusTarget } from './field-context'
import { ValueControls, ValueEditor, valueAreaClass, valueIsRegion } from './value-editors'

/**
 * The caret column. Every row has one, whether or not it holds a caret:
 * giving it only to maps indented them past their own siblings, and past
 * their own children, so the one thing an indent is for — depth — was the
 * one thing it did not say.
 *
 * It is as narrow as a caret and a hit target allow, because on a document
 * whose only map is its last field it is twelve rows of nothing: the tree
 * is already the one thing in the panel that starts right of the panel's
 * own content column, and every pixel here widens that step.
 */
export const GUTTER = 'flex h-8 w-4 shrink-0 items-center justify-center'

/** What a container shows where a value would be. */
const SUMMARY =
  'flex h-8 min-w-0 flex-1 items-center truncate font-mono text-[12px] text-kumo-subtle'

/**
 * The air between one field and the next, which is the other half of
 * giving a value a box: a column of boxes two pixels apart is a wall, and
 * the same column twelve pixels apart is a list. It was six and still read
 * as cramped. Supabase spends fifty-three on the same gap, which it can,
 * because a Postgres row is six columns and never nests; a document this
 * tall cannot, so this is as much as a row can afford.
 */
const BETWEEN = 'gap-y-3.5'

/**
 * The gap *inside* one field, which is not the gap between two of them.
 * A row holds its line, the region below a long value, its notes and its
 * children, and those are one thing: given the list's own gap they drift
 * apart, and an error message a field's height below the field reads as
 * belonging to the next one. A subgrid inherits the gaps of the grid above
 * it unless it says otherwise, so a row says otherwise.
 */
const WITHIN = 'gap-y-1'

/**
 * A list of siblings, and the two columns they share: one sized to the
 * widest name among them, one taking the rest.
 *
 * Names were a column already and values were not — on a real document
 * they began at eight different offsets spread over 58 px, so reading down
 * the values, which is half of what anyone does with a document, meant
 * following a staircase. The track does it with no measuring: `max-content`
 * is the widest name, and each row is a `subgrid` so it can still paint its
 * own ground and carry its own controls.
 *
 * Once per document, not once per list. A nested list used to build its
 * own tracks, which sized its name column to its own widest name — so a
 * map of short names inside a document of long ones started its values
 * left of its parent's siblings and ran wider than them, and a child read
 * as an outdent. Every depth is a `subgrid` of this one now.
 */
export const COLUMNS = `grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-2 ${BETWEEN}`

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
  const [open, setOpen] = useState(() => !large(node))
  const problem = editing.problems.get(node.id)
  const container = node.type === 'map' || node.type === 'array'
  const label = named ? node.name || 'new field' : String(index)
  const unsaved = soft && node.name.trim() !== '' && editing.changed.has(node.name.trim())
  const renamedFrom = node.was !== undefined && node.was !== node.name.trim() ? node.was : undefined
  const raw = container && node.raw === true
  // JSON that will not parse cannot become rows, and the row says why
  // underneath it either way.
  const broken = raw && problem?.value !== undefined
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
        className="col-span-2 flex items-center gap-1 rounded-md py-0.5 pr-1 pl-0.5 opacity-70"
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
    <div
      className={`group/row col-span-2 grid grid-cols-subgrid ${WITHIN}`}
      data-testid="field-row"
    >
      {/* The ground is the line's, not each control's. Hovering a row is how
          you see which field you are on — the thing a column of twenty
          one-line rows has to answer and a column of blocks never had to. */}
      <div className="group/line relative col-span-2 grid grid-cols-subgrid items-start rounded-md hover:bg-kumo-tint focus-within:bg-kumo-tint">
        <div className="flex items-start gap-1 pl-0.5">
          <span className={GUTTER}>
            {container && (
              <button
                type="button"
                className="flex size-4 items-center justify-center rounded text-kumo-subtle hover:bg-kumo-base"
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
            <span className="flex h-8 min-w-4 shrink-0 items-center justify-end font-mono text-[12px] text-kumo-subtle tabular-nums">
              {index}
            </span>
          )}
          {/* Which fields the footer's count is counting. Save is the row's
              own accent, and this is what it is about to write. Its place is
              always kept: appearing would otherwise widen the name column
              and shift every value in the list the first time one is
              edited, which is the jitter this layout is here to end. */}
          <span className="flex h-8 w-1.5 shrink-0 items-center">
            {unsaved && (
              <span
                className="size-1.5 rounded-full bg-kumo-brand"
                title="Unsaved"
                data-testid="unsaved-mark"
              />
            )}
          </span>
        </div>
        <div className="flex min-w-0 items-start gap-1 pr-1">
          {container ? (
            raw || open ? (
              <span className={SUMMARY} data-testid="field-summary">
                {raw ? 'json' : ''}
              </span>
            ) : (
              /* What it holds is also the way in. The caret is four
                 pixels of chevron and the words beside it are the thing
                 the eye went to; a redundant pointer target, so it stays
                 out of the tab order and leaves the caret to say what it
                 is to anything that is not a pointer. */
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={() => setOpen(true)}
                className={`${SUMMARY} cursor-pointer rounded text-left hover:text-kumo-default`}
                data-testid="field-summary"
              >
                {preview(node)}
              </button>
            )
          ) : region ? (
            <span className="h-8 min-w-0 flex-1" />
          ) : (
            <ValueEditor
              node={node}
              onChange={onChange}
              label={label}
              invalid={problem?.value !== undefined}
            />
          )}
        </div>
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
                  to be asked for. The line says `json` while it is in use.
                  The two are the same subtree written two ways, so the
                  button converts rather than flipping a flag: it used to
                  do the latter, which showed `{}` for a map with fields in
                  it and would have saved that. */}
              <Tooltip
                content={
                  raw
                    ? broken
                      ? 'Fix the JSON to go back to rows'
                      : 'Back to rows'
                    : 'Edit as JSON'
                }
                render={
                  <Button
                    variant={raw ? 'secondary' : 'ghost'}
                    size="xs"
                    shape="square"
                    icon={<BracketsCurlyIcon />}
                    aria-label={`Edit ${label} as JSON`}
                    disabled={broken}
                    onClick={() => onChange(toggleRaw(node))}
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
        <div className="col-span-2 pt-0.5 pb-1 pl-6">
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
        <span className="col-span-2 block pl-6 text-[11px] text-kumo-subtle">
          Renaming <span className="font-mono">{renamedFrom}</span> here changes this document only.
        </span>
      )}
      {problem?.value !== undefined && (
        <span className="col-span-2 block pl-6 text-[12px] text-kumo-danger">{problem.value}</span>
      )}
      {problem?.name !== undefined && (
        <span className="col-span-2 block pl-6 text-[12px] text-kumo-danger">{problem.name}</span>
      )}
      {container && !raw && open && node.children.length > 0 && (
        // The step is the gutter's own width, so a child's name lands one
        // column right of its parent's — never, as it did, to the left.
        //
        // `subgrid`, not a grid of its own: a nested list used to size a
        // name column to its own widest name, so a list of short names
        // inside a document of long ones started its values 26 px to the
        // LEFT of its parent's siblings and ran that much wider. A child
        // burst out of the column containing it, which reads as an
        // outdent. Sharing the document's tracks costs nothing, because a
        // subgrid takes its own margin and padding out of the edge track:
        // the indent narrows this list's names and leaves every value in
        // the document on one rail.
        <div
          className={`col-span-2 ml-2.5 grid grid-cols-subgrid border-l border-kumo-line pl-2.5 ${BETWEEN}`}
        >
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

/**
 * What a shut container holds, on one line.
 *
 * It used to be a count — `{ 1 field }` — which is the one thing about a
 * map you can already see, since its fields are listed directly beneath
 * it. Worse, it said it while the map was *open*, where the children were
 * right there saying it better. A name is what you are looking for when
 * you scan a document, so the keys are what this says, and how many more
 * there are when they do not fit in three.
 */
function preview(node: DraftNode): string {
  const live = node.children.filter((child) => child.removed !== true)
  const map = node.type === 'map'
  if (live.length === 0) return map ? '{}' : '[]'
  const shown = live.slice(0, 3).map((child) => (map ? child.name || '…' : brief(child)))
  const rest = live.length - shown.length
  const inside = [...shown, ...(rest > 0 ? [`+${rest}`] : [])].join(', ')
  return map ? `{ ${inside} }` : `[ ${inside} ]`
}

/** An array item has no name, so it is the value that stands for it. */
function brief(node: DraftNode): string {
  if (node.type === 'map') return '{…}'
  if (node.type === 'array') return '[…]'
  if (node.type === 'null') return 'null'
  const text = node.text.trim()
  if (text === '') return node.type
  const short = text.length > 12 ? `${text.slice(0, 12)}…` : text
  return node.type === 'string' ? `"${short}"` : short
}

/**
 * A container large enough that opening it buries whatever follows it.
 * A document opens scannable: the small maps are shown, the big ones say
 * what they hold and wait to be asked.
 */
const LARGE = 6

function large(node: DraftNode): boolean {
  let count = 0
  const walk = (nodes: readonly DraftNode[]): void => {
    for (const child of nodes) {
      if (child.removed === true || count > LARGE) continue
      count += 1
      walk(child.children)
    }
  }
  walk(node.children)
  return count > LARGE
}

/**
 * The name reads as a name and edits as a field. It wears no chrome at
 * rest — this is a label you read far more often than you change — and it
 * takes the width of what it says, so the value it belongs to can sit
 * beside it instead of on the next line.
 *
 * It is the one thing in the panel set in the interface face rather than
 * the monospace one. Name and value were both 12 px mono, which is two
 * kinds of thing in one voice: the eye had nothing to tell the label from
 * the data it labels, and a column of pairs read as a column of tokens.
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
      className={`h-8 w-auto max-w-40 min-w-10 shrink-0 rounded bg-transparent px-1.5 text-[13px] font-medium text-kumo-default outline-none field-sizing-content placeholder:font-normal placeholder:text-kumo-inactive focus:bg-kumo-control focus:ring focus:ring-kumo-focus ${
        invalid ? 'ring ring-kumo-danger' : ''
      }`}
      aria-label={node.name ? `${node.name} name` : 'Field name'}
      data-testid="field-name"
    />
  )
}
