// Editing a value where it is: double-click a cell, or press Enter on it.
//
// One editor, laid over the cell, holding the inspector's own editors. Two
// shapes were on the table — an input inside the cell, and a popover hung
// below it — and each is right for half the types and wrong for the other.
//
// An input inside the cell is how a spreadsheet edits, and it is the
// fastest thing there is for a word or a number: the text is where it was,
// you type, Enter. But a cell is as wide as its column, and that is the
// whole problem. A 120 px number column has no room for the `integer` /
// `double` word Firestore needs said; a timestamp needs its calendar; a
// reference wants its completions; a map is a tree and cannot be a line at
// all. The old in-cell input handled five types and sent the other six to
// the inspector, which is how this was asked for in the first place.
//
// A popover below the cell holds anything, but it puts the value being
// edited somewhere other than where the eye already is, and it wraps a
// one-word change in a title, a box and two buttons.
//
// So the editor starts where the cell is and is as big as the value needs.
// A value that is a line — a string, a number, a boolean, a timestamp, a
// reference, a geopoint, bytes, null — opens *on* the cell, at least as wide
// as it, its text where the cell's text was: inline in everything but the
// constraint. A value that is a structure — a map, an array, a vector, a
// string with newlines — opens as a panel from the same corner, with the
// field tree the inspector uses inside it. Same rows, same type menu, same
// add-an-entry and edit-as-JSON, because it is the same component: there
// is one way to edit a Firestore value in this console, and the grid is
// now one more place it appears.
//
// Enter saves, Escape gives up, and clicking anywhere else saves — the
// spreadsheet's rules, which is what a grid is read as. Only the field is
// written, with a mask, so nothing else in the document can be lost to a
// value someone else changed while this one was open.

import { Button, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { BracketsCurlyIcon, PlusIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InferredColumn } from '../columns'
import {
  type DraftNode,
  emptyNode,
  nodeFrom,
  parseNode,
  problemsOf,
  retype,
  sameValue,
  toggleRaw,
} from '../draft'
import { documentQuery } from '../queries'
import { commit, documentRoot, quoteFieldSegment } from '../rest'
import { type FsDocument, type FsValue, encodeValue, isPartial } from '../value'
import { type FieldEditing, FieldEditingProvider } from './field-context'
import { COLUMNS, FieldRows } from './field-row'
import { StripButton } from './strip-button'
import { TypeMenu } from './type-menu'
import { ValueControls, ValueEditor, valueAreaClass, valueIsRegion } from './value-editors'
import { useWorkbench } from './workbench-context'

/**
 * The least room each line of value needs, px: the box, the word inside it
 * where a type has one (`integer`, `7 mo ago`, `ref`), and the type menu.
 * Measured against the inspector's own rows, where these editors were built
 * to sit; a cell wider than this keeps its own width.
 */
const LINE_WIDTH: Record<string, number> = {
  string: 280,
  number: 220,
  boolean: 170,
  timestamp: 340,
  reference: 340,
  geopoint: 360,
  bytes: 320,
  null: 200,
}
const PANEL_WIDTH = 460
const MAX_WIDTH = 600
/** Room kept between the editor and the window's edge, px. */
const MARGIN = 8

type Layout = 'line' | 'panel'

/** What a cell is when it opens: its value, or the column's type with nothing in it yet. */
function startNode(field: string, value: FsValue | undefined, column?: InferredColumn): DraftNode {
  // A field this document does not have, or one set to null, is opened as
  // the type its column holds — the field it is missing is the one every
  // other row has, and that is what is about to be typed. Opening it as
  // `null` would ask for a trip to the type menu before every first value.
  if (value && value.type !== 'null') return nodeFrom(field, value)
  const type = column && column.type !== 'null' ? column.type : 'string'
  return emptyNode(field, type)
}

function layoutOf(node: DraftNode): Layout {
  if (node.type === 'map' || node.type === 'array' || node.raw === true) return 'panel'
  return valueIsRegion(node) ? 'panel' : 'line'
}

/** Where focus goes when the editor opens: the value, or a structure's first entry. */
function focusTarget(node: DraftNode): string | undefined {
  if (node.type === 'map' || node.type === 'array') {
    if (node.raw === true) return undefined
    const first = node.children[0]
    if (!first) return undefined
    return first.type === 'map' || first.type === 'array' ? undefined : first.id
  }
  return node.id
}

export function CellEditor({
  document,
  field,
  column,
  anchor,
  bounds,
  onDone,
}: {
  document: FsDocument
  field: string
  column: InferredColumn | undefined
  /** The cell, found afresh each time: a row can re-render under the editor. */
  anchor: () => HTMLElement | null
  /** The part of the grid cells can be seen in; the editor hides while its cell is outside. */
  bounds: () => DOMRect | null
  onDone: () => void
}) {
  const workbench = useWorkbench()
  const stored = document.fields[field]
  // A grid page is a preview: a long string arrives as its first bytes and a
  // big map as its first entries. Saving what arrived would write the
  // fragment over the value, so the whole document is fetched first — the
  // same query the inspector holds, so a row already open costs nothing.
  const partial = stored !== undefined && isPartial(stored)
  const whole = useQuery({ ...documentQuery(workbench.scope, document.path), enabled: partial })

  if (partial && !whole.data)
    return (
      <Floating anchor={anchor} bounds={bounds} minWidth={LINE_WIDTH.string ?? 280}>
        {({ rootProps }) => (
          <div
            {...rootProps}
            className="flex h-9 items-center rounded-lg bg-kumo-base px-3 text-[12px] text-kumo-subtle shadow-lg ring ring-kumo-line"
            onKeyDown={(event) => {
              if (event.key === 'Escape') onDone()
            }}
            tabIndex={-1}
          >
            {whole.isError
              ? `Could not read the whole value: ${whole.error.message}`
              : 'Reading the whole value…'}
          </div>
        )}
      </Floating>
    )

  const value = partial ? whole.data?.fields[field] : stored
  return (
    <Editing
      document={document}
      field={field}
      column={column}
      value={value}
      anchor={anchor}
      bounds={bounds}
      onDone={onDone}
    />
  )
}

function Editing({
  document,
  field,
  column,
  value,
  anchor,
  bounds,
  onDone,
}: {
  document: FsDocument
  field: string
  column: InferredColumn | undefined
  value: FsValue | undefined
  anchor: () => HTMLElement | null
  bounds: () => DOMRect | null
  onDone: () => void
}) {
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const toasts = useKumoToastManager()
  const [initial] = useState(() => startNode(field, value, column))
  const [node, setNode] = useState(initial)
  const [focus, setFocus] = useState<string | undefined>(() => focusTarget(initial))
  const [error, setError] = useState<string | undefined>()
  const closed = useRef(false)
  const layout = layoutOf(node)
  const container = node.type === 'map' || node.type === 'array'
  const raw = container && node.raw === true
  const problems = problemsOf([node])
  const problem = problems.get(node.id)

  const change = (next: DraftNode) => {
    setNode(next)
    setError(undefined)
  }

  const save = useMutation({
    mutationFn: (next: FsValue) =>
      commit(workbench.scope, [
        {
          update: {
            path: document.path,
            fields: { [field]: encodeValue(next, documentRoot(workbench.scope)) },
            mask: [quoteFieldSegment(field)],
            exists: true,
          },
        },
      ]),
    onSuccess: () => {
      closed.current = true
      void queryClient.invalidateQueries({ queryKey: ['fs', workbench.database] })
      onDone()
    },
    onError: (failure) => {
      setError(failure.message)
      toasts.add({ title: 'Not saved', description: failure.message, variant: 'error' })
    },
  })

  const finish = () => {
    if (closed.current || save.isPending) return
    // Opened and left alone, which includes a missing field opened as its
    // column's type: nothing was typed, so nothing is written.
    if (node === initial) {
      closed.current = true
      onDone()
      return
    }
    const parsed = parseNode(node)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    if (value && sameValue(value, parsed.value)) {
      closed.current = true
      onDone()
      return
    }
    save.mutate(parsed.value)
  }
  const cancel = () => {
    closed.current = true
    onDone()
  }

  // Clicking anywhere else is "done with this one", as it is in a sheet.
  // The editor's own menus and calendars are portals, outside it in the
  // page but inside it in React, so a press there arrives here first and
  // marks itself as inside.
  const inside = useRef(false)
  const onOutside = useEffectEvent(() => finish())
  useEffect(() => {
    const press = () => {
      if (!inside.current) onOutside()
      inside.current = false
    }
    window.document.addEventListener('pointerdown', press)
    return () => window.document.removeEventListener('pointerdown', press)
  }, [])

  // A value that changes shape — a string given a newline, a field turned
  // into a map — swaps the editor it is typed in, and focus goes with it.
  const [shape, setShape] = useState(layout)
  if (shape !== layout) {
    setShape(layout)
    setFocus(focusTarget(node))
  }

  const editing: FieldEditing = {
    problems,
    known: [],
    changed: NOTHING,
    focus,
    takeFocus: setFocus,
    next: finish,
    onOpenReference: (path) => {
      finish()
      workbench.selectDocument(path)
    },
  }

  const addEntry = () => {
    const child = emptyNode('', 'string')
    change({ ...node, children: [...node.children, child] })
    setFocus(node.type === 'map' ? `${child.id}:name` : child.id)
  }

  const live = node.children.filter((child) => child.removed !== true).length
  const shown = error ?? problem?.value ?? problem?.name

  return (
    <FieldEditingProvider value={editing}>
      <Floating
        anchor={anchor}
        bounds={bounds}
        minWidth={layout === 'panel' ? PANEL_WIDTH : (LINE_WIDTH[node.type] ?? 280)}
      >
        {({ rootProps, root, maxHeight }) => (
          <div
            {...rootProps}
            role="dialog"
            aria-label={`Edit ${field}`}
            data-testid="cell-editor"
            data-layout={layout}
            tabIndex={-1}
            onPointerDownCapture={() => {
              inside.current = true
            }}
            onKeyDown={(event) => {
              // Keys pressed in the editor's own menus arrive here too, by
              // way of React; those menus answer Escape and Enter themselves.
              const own = root.current?.contains(event.target as Node) === true
              if (!own) return
              if (event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault()
                cancel()
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                finish()
              } else if (
                event.key === 'Enter' &&
                (event.target as HTMLElement).getAttribute('role') === 'switch'
              ) {
                // Space flips a switch; Enter is done, as on every other line.
                event.preventDefault()
                finish()
              }
            }}
            className="outline-none"
          >
            {layout === 'line' ? (
              // `minmax(0, …)`: a grid track is otherwise as wide as its
              // content's minimum, and two inputs side by side — a
              // geopoint — made that 461 px in a 320 px editor.
              <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
                <div className="flex items-start gap-1 rounded-lg bg-kumo-base p-0.5 shadow-lg ring ring-kumo-line">
                  <div className="flex min-w-0 flex-1 items-start">
                    <ValueEditor
                      node={node}
                      onChange={change}
                      label={field}
                      invalid={problem?.value !== undefined || error !== undefined}
                      formOutside
                    />
                  </div>
                  <span className="flex h-8 shrink-0 items-center gap-0.5">
                    <ValueControls node={node} onChange={change} label={field} />
                    <TypeMenu
                      type={node.type}
                      label={field}
                      onPick={(type) => change(retype(node, type))}
                    />
                  </span>
                </div>
                {shown !== undefined && <Problem>{shown}</Problem>}
              </div>
            ) : (
              <div
                className="flex flex-col overflow-hidden rounded-lg bg-kumo-base shadow-lg ring ring-kumo-line"
                style={{ maxHeight }}
              >
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-kumo-line pr-1.5 pl-3">
                  <span className="min-w-0 truncate font-mono text-[12px] font-medium text-kumo-default">
                    {field}
                  </span>
                  {container && !raw && (
                    <span className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums">
                      {node.type === 'map' ? `{${live}}` : `[${live}]`}
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    {container && !raw && (
                      <Tooltip
                        content={node.type === 'map' ? 'Add an entry' : 'Add an item'}
                        render={
                          <StripButton
                            label={`Add to ${field}`}
                            icon={<PlusIcon size={14} />}
                            onClick={addEntry}
                          />
                        }
                      />
                    )}
                    {container && (
                      <Tooltip
                        content={raw ? 'Back to rows' : 'Edit as JSON'}
                        render={
                          <StripButton
                            label={`Edit ${field} as JSON`}
                            icon={<BracketsCurlyIcon size={14} />}
                            on={raw}
                            disabled={raw && problem?.value !== undefined}
                            onClick={() => change(toggleRaw(node))}
                          />
                        }
                      />
                    )}
                    {!container && <ValueControls node={node} onChange={change} label={field} />}
                    <TypeMenu
                      type={node.type}
                      label={field}
                      onPick={(type) => change(retype(node, type))}
                    />
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {container && !raw ? (
                    <div className={`py-2 pr-3 pl-5 ${COLUMNS}`}>
                      <FieldRows
                        nodes={node.children}
                        named={node.type === 'map'}
                        onChange={(children) => change({ ...node, children })}
                      />
                      {live === 0 && (
                        <button
                          type="button"
                          onClick={addEntry}
                          className="col-span-2 h-8 rounded-md text-left text-[12px] text-kumo-subtle hover:text-kumo-default"
                        >
                          {node.type === 'map'
                            ? 'No entries yet. Add one'
                            : 'No items yet. Add one'}
                        </button>
                      )}
                    </div>
                  ) : raw ? (
                    <div className="p-2">
                      <textarea
                        value={node.text}
                        onChange={(event) => change({ ...node, text: event.target.value })}
                        rows={Math.min(16, Math.max(4, node.text.split('\n').length))}
                        spellCheck={false}
                        className={valueAreaClass(problem?.value !== undefined)}
                        aria-label={`${field} value`}
                        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the editor was opened to type in this
                        autoFocus
                      />
                    </div>
                  ) : (
                    <div className="p-2">
                      <ValueEditor
                        node={node}
                        onChange={change}
                        label={field}
                        invalid={problem?.value !== undefined}
                      />
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2 border-t border-kumo-line py-1.5 pr-1.5 pl-3">
                  <span
                    className={`min-w-0 flex-1 truncate text-[12px] ${
                      shown === undefined ? 'text-kumo-subtle' : 'text-kumo-danger'
                    }`}
                    title={shown}
                  >
                    {shown ?? (
                      <>
                        <Key>⌘</Key>
                        <Key>↵</Key> saves · <Key>esc</Key> cancels
                      </>
                    )}
                  </span>
                  <Button variant="ghost" size="sm" onClick={cancel}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={finish}
                    loading={save.isPending}
                    data-testid="cell-editor-save"
                  >
                    Save
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Floating>
    </FieldEditingProvider>
  )
}

const NOTHING: ReadonlySet<string> = new Set()

function Problem({ children }: { children: ReactNode }) {
  return (
    <div
      className="w-fit max-w-full rounded-md bg-kumo-base px-2 py-1 text-[12px] text-kumo-danger shadow-md ring ring-kumo-line"
      role="alert"
    >
      {children}
    </div>
  )
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="mx-px rounded border border-kumo-hairline bg-kumo-base px-1 font-sans text-[10px]">
      {children}
    </kbd>
  )
}

/**
 * The editor's box: in a portal, so a column's width and the grid's own
 * scrolling clip nothing, and placed from the cell's rectangle for as long
 * as anything moves.
 *
 * A line sits on the cell, nudged so its text starts where the cell's text
 * did. A panel opens from the same corner and moves up when the window has
 * no room below for it.
 */
function Floating({
  anchor,
  bounds,
  minWidth,
  children,
}: {
  anchor: () => HTMLElement | null
  bounds: () => DOMRect | null
  minWidth: number
  children: (props: {
    rootProps: { ref: React.RefObject<HTMLDivElement | null> }
    root: React.RefObject<HTMLDivElement | null>
    maxHeight: number
  }) => ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  // Measured before the first paint, not after it: an editor drawn hidden
  // while it waits for a position cannot take focus, and the value it was
  // opened to type into would not have the keyboard.
  const [cell, setCell] = useState(() => place(anchor, bounds))
  const [height, setHeight] = useState(0)

  useLayoutEffect(() => {
    const measure = () => {
      const next = place(anchor, bounds)
      if (next) setCell(next)
    }
    // Capture, because the scroller that moves the cell is not the window.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [anchor, bounds])

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight))
    observer.observe(element)
    setHeight(element.offsetHeight)
    return () => observer.disconnect()
  }, [])

  // Focus lands inside once the editors have taken theirs: a value with no
  // text to type into — a boolean, null — still needs the keyboard here so
  // Escape and Enter mean something.
  useEffect(() => {
    const element = root.current
    if (!element || element.contains(window.document.activeElement)) return
    const first = element.querySelector<HTMLElement>(
      'input, textarea, [role="switch"], button:not([tabindex="-1"])',
    )
    ;(first ?? element).focus()
  }, [])

  const rect = cell?.rect
  const maxHeight = Math.min(560, window.innerHeight - MARGIN * 2)
  const room = window.innerWidth - MARGIN * 2
  const width = Math.min(room, MAX_WIDTH, Math.max(minWidth, (rect?.width ?? 0) + 8))
  const left = rect
    ? Math.min(Math.max(MARGIN, rect.left - 4), window.innerWidth - width - MARGIN)
    : MARGIN
  const top = rect
    ? Math.max(MARGIN, Math.min(rect.top, window.innerHeight - height - MARGIN))
    : MARGIN
  return createPortal(
    <div
      className={`fixed z-50 ${cell?.seen === false || !rect ? 'invisible' : ''}`}
      // Measured coordinates: the one thing a class cannot carry.
      style={{ left, top, width }}
    >
      {children({ rootProps: { ref: root }, root, maxHeight })}
    </div>,
    window.document.body,
  )
}

/** Where the cell is, and whether any of it can be seen in the grid. */
function place(
  anchor: () => HTMLElement | null,
  bounds: () => DOMRect | null,
): { rect: DOMRect; seen: boolean } | null {
  const element = anchor()
  if (!element) return null
  const rect = element.getBoundingClientRect()
  const area = bounds()
  const seen =
    !area ||
    (rect.bottom > area.top + 4 &&
      rect.top < area.bottom - 4 &&
      rect.right > area.left + 4 &&
      rect.left < area.right - 4)
  return { rect, seen }
}
