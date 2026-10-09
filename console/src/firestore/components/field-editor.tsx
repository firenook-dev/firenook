// The fields of one document, as rows you can edit and as the JSON behind
// them. The caller owns the tree (it is the caller that saves it); the panel
// owns the JSON text, where focus is going, and the line that adds a field.
//
// Text is kept exactly as typed and parsed on every keystroke, so a
// half-written value never fights the cursor and a wrong one says so where
// it is, rather than at the end as "fix the highlighted fields".

import { Button, DropdownMenu, Tabs, Text, Tooltip } from '@cloudflare/kumo'
import { PlusIcon } from '@phosphor-icons/react'
import { useCallback, useRef, useState } from 'react'
import { CodeEditor } from '@/components/code-editor'
import { TypeBadge } from '@/components/kit'
import { type DraftNode, type NodeProblem, emptyNode, nodesFromJson, nodesToJson } from '../draft'
import { typeMarks } from '../json-marks'
import { type FirestoreValueType, VALUE_TYPES } from '../value'
import { Completion, Completions } from './completions'
import { type FieldEditing, FieldEditingProvider, type KnownField } from './field-context'
import { COLUMNS, FieldRows } from './field-row'

const NO_FIELDS: KnownField[] = []

/** The document laid out, or nothing if it is not a document yet. */
function tidyJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return undefined
  }
}
const NOTHING_CHANGED: ReadonlySet<string> = new Set()

export function FieldsPanel({
  nodes,
  onNodesChange,
  problems,
  known = NO_FIELDS,
  changed = NOTHING_CHANGED,
  tab,
  onTabChange,
  onOpenReference,
}: {
  nodes: DraftNode[]
  onNodesChange: (next: DraftNode[]) => void
  problems: Map<string, NodeProblem>
  /** What the rest of the collection calls its fields, for completing a new one. */
  known?: readonly KnownField[] | undefined
  /** Fields the next Save will write, marked so the count has somewhere to point. */
  changed?: ReadonlySet<string> | undefined
  tab: 'fields' | 'json'
  onTabChange: (tab: 'fields' | 'json') => void
  onOpenReference: (path: string) => void
}) {
  const [json, setJson] = useState('')
  const [jsonTab, setJsonTab] = useState<'fields' | 'json'>('fields')
  const [jsonError, setJsonError] = useState<string | undefined>()
  const [focus, setFocus] = useState<string | undefined>()
  const addRef = useRef<HTMLInputElement>(null)

  // Opening the JSON tab shows the rows as they are now (derived in render).
  if (tab !== jsonTab) {
    setJsonTab(tab)
    if (tab === 'json') {
      setJson(JSON.stringify(nodesToJson(nodes), null, 2))
      setJsonError(undefined)
    }
  }

  const applyJson = () => {
    try {
      onNodesChange(nodesFromJson(json, nodes))
      setJsonError(undefined)
      onTabChange('fields')
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error))
    }
  }

  const format = () => {
    const tidied = tidyJson(json)
    if (tidied === undefined) {
      setJsonError('This is not JSON yet, so there is nothing to lay out')
      return
    }
    setJson(tidied)
    setJsonError(undefined)
  }

  // The rows are what carry the types JSON cannot write down, so the
  // marks are recomputed when they change and not on every keystroke.
  const annotate = useCallback((text: string) => typeMarks(text, nodes), [nodes])

  const editing: FieldEditing = {
    problems,
    known,
    changed,
    focus,
    takeFocus: setFocus,
    next: () => addRef.current?.focus(),
    onOpenReference,
  }

  const live = nodes.filter((node) => node.removed !== true)
  const taken = new Set(live.map((node) => node.name.trim()))

  return (
    <FieldEditingProvider value={editing}>
      <div className="shrink-0 border-b border-kumo-line px-5 py-2">
        <Tabs
          size="sm"
          variant="segmented"
          value={tab}
          onValueChange={(value) => onTabChange(value as 'fields' | 'json')}
          tabs={[
            { value: 'fields', label: `Fields · ${live.length}` },
            { value: 'json', label: 'JSON' },
          ]}
        />
      </div>
      {tab === 'fields' ? (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            {/* The right margin is the left one: the caret column insets
                every name by its own width whether or not it holds a
                caret, and nothing was answering it on the other side, so
                a value ran to the panel's edge while its name started a
                clear step in from it. The cell keeps its own `pr-1`, so
                this is that step less what the cell already spends. */}
            <div className={`py-2 pr-4 pl-5 ${COLUMNS}`}>
              <FieldRows nodes={nodes} named onChange={onNodesChange} soft />
              {nodes.length === 0 && (
                <div className="px-2 py-1">
                  <Text variant="secondary" size="sm">
                    No fields yet.
                  </Text>
                </div>
              )}
            </div>
          </div>
          {/* Below the scroller, not inside it. A document with forty
              fields should not need scrolling to the end to gain a
              forty-first, and the one line that is always worth reaching
              is the one that adds a field. */}
          <div className="shrink-0 border-t border-kumo-line py-1.5 pr-3 pl-5">
            <AddField
              inputRef={addRef}
              known={known}
              taken={taken}
              onAdd={(name, type) => {
                const node = emptyNode(name, type)
                onNodesChange([...nodes, node])
                setFocus(node.id)
              }}
            />
          </div>
        </>
      ) : (
        <>
          {/* The editor is the view. A twelve-row box held 224 pixels of a
              593-pixel panel and scrolled the document inside them, while
              282 pixels below it — half the panel — stayed empty. Nothing
              else wanted that room, and the one thing here that can always
              use more of it is the text. */}
          {/* A floor as well as a share. In the inspector the editor
              fills a panel that is already tall; in the create dialog it
              is one of three things inside a box that grows to its
              content, and a `flex-1` with no height of its own let that
              box collapse to its minimum and leave three lines of room
              to paste a document into. */}
          <div className="flex min-h-[220px] flex-1 flex-col p-3">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md ring ring-kumo-line focus-within:ring-kumo-focus">
              <CodeEditor
                value={json}
                onChange={setJson}
                annotate={annotate}
                tidyPaste={tidyJson}
                ariaLabel="Document JSON"
                testId="document-json"
              />
            </div>
          </div>
          {/* The band the Fields tab puts its one action in, with this
              tab's one action in it. Below the editor rather than after
              it, so growing the editor never pushes Apply out of reach. */}
          <div className="shrink-0 border-t border-kumo-line px-3 py-2" data-testid="json-actions">
            {jsonError && (
              <Text variant="error" size="sm" as="p" DANGEROUS_className="mb-1.5">
                {jsonError}
              </Text>
            )}
            {/* The tool on the left and the action on the right, which
                is where the Fields tab has had Add field all along and
                where the footer has Save. This band was the only one of
                the three facing the other way, measured at 418 pixels
                from the panel's right edge against Add field's 11.

                Minify stood here too, and nobody has ever needed a
                Firestore document on one line: it was a button because
                `JSON.stringify` takes a third argument, not because the
                job exists. Format stays, and mostly has nothing to do —
                the tab opens laid out, and a document pasted over this
                one arrives laid out — but hand-editing can still leave
                it ragged, and a visible one-click fix beats a shortcut
                nobody is told about. */}
            <div className="flex items-center gap-1">
              <Tooltip
                content="Lay the document out again, two spaces"
                render={
                  <Button variant="ghost" size="sm" onClick={format} data-testid="format-json">
                    Format
                  </Button>
                }
              />
              <span className="ml-auto">
                <Button variant="secondary" size="sm" onClick={applyJson} data-testid="apply-json">
                  Apply to fields
                </Button>
              </span>
            </div>
          </div>
        </>
      )}
    </FieldEditingProvider>
  )
}

/**
 * Adding a field is one line. The name completes from what the rest of the
 * collection calls its fields and brings that field's usual type with it, so
 * the common case — this document is missing the one field every other
 * document has — is a keystroke and a tick rather than a name, a type menu
 * and a value that resets when the type changes.
 */
function AddField({
  inputRef,
  known,
  taken,
  onAdd,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  known: readonly KnownField[]
  taken: ReadonlySet<string>
  onAdd: (name: string, type: FirestoreValueType) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<FirestoreValueType>('string')
  const [open, setOpen] = useState(false)

  const typed = name.trim()
  const matches = known
    .filter(
      (item) => !taken.has(item.field) && item.field.toLowerCase().startsWith(typed.toLowerCase()),
    )
    .slice(0, 6)
  const add = (field: string, fieldType: FirestoreValueType) => {
    const trimmed = field.trim()
    if (!trimmed || taken.has(trimmed)) return
    onAdd(trimmed, fieldType)
    setName('')
    setType('string')
    setOpen(false)
  }

  return (
    <div className="flex items-center gap-1">
      <input
        ref={inputRef}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(event) => {
          const first = matches[0]
          if (event.key === 'Tab' && first && first.field !== typed) {
            event.preventDefault()
            setName(first.field)
            setType(first.type)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            add(name, type)
          } else if (event.key === 'Escape') setOpen(false)
        }}
        placeholder="New field name"
        spellCheck={false}
        autoComplete="off"
        className="h-8 min-w-0 flex-1 rounded-md bg-kumo-control px-2 text-[13px] text-kumo-default ring ring-kumo-line outline-none placeholder:text-kumo-inactive focus:ring-kumo-focus"
        aria-label="New field name"
        data-testid="new-field-name"
      />
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              className="group flex h-8 shrink-0 items-center rounded px-0.5 hover:bg-kumo-tint"
              aria-label={`New field type: ${type}`}
            >
              <TypeBadge type={type} menu />
            </button>
          }
        />
        <DropdownMenu.Content>
          <DropdownMenu.RadioGroup
            value={type}
            onValueChange={(value) => setType(value as FirestoreValueType)}
          >
            {VALUE_TYPES.map((item) => (
              <DropdownMenu.RadioItem key={item} value={item} closeOnClick>
                <span className="font-mono text-[12px]">{item}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu>
      {/* The one action of this line is never drawn as unavailable. It was
          `ghost` and `disabled` until a name was typed, which is every
          moment anybody is looking for it: half opacity on an already
          subtle grey, beside a placeholder and a type chip that are both
          subtle too, so nothing in the band was at full strength and the
          band that advertises "you can add a field" was the faintest ink
          in the panel. A user said it "feels not so visible".

          A border gives it a shape, and with nothing typed it points at
          the field that needs filling rather than refusing the click. A
          control that can always begin its own job has no disabled state
          to draw. */}
      <Button
        variant="secondary"
        size="sm"
        icon={<PlusIcon />}
        onClick={() => (typed ? add(name, type) : inputRef.current?.focus())}
        data-testid="add-field"
      >
        Add field
      </Button>
      {open && matches.length > 0 && (
        <Completions anchor={inputRef} testId="field-completions">
          {matches.map((item) => (
            <Completion
              key={item.field}
              label={item.field}
              detail={`${item.type} · ${item.present}`}
              onPick={() => add(item.field, item.type)}
            />
          ))}
        </Completions>
      )}
    </div>
  )
}
