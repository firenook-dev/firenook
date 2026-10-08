// The fields of one document, as rows you can edit and as the JSON behind
// them. The caller owns the tree (it is the caller that saves it); the panel
// owns the JSON text, where focus is going, and the line that adds a field.
//
// Text is kept exactly as typed and parsed on every keystroke, so a
// half-written value never fights the cursor and a wrong one says so where
// it is, rather than at the end as "fix the highlighted fields".

import { Button, DropdownMenu, Tabs, Text } from '@cloudflare/kumo'
import { PlusIcon } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import { TypeBadge } from '@/components/kit'
import { type DraftNode, type NodeProblem, emptyNode, nodesFromJson, nodesToJson } from '../draft'
import { type FirestoreValueType, VALUE_TYPES } from '../value'
import { Completion, Completions } from './completions'
import { type FieldEditing, FieldEditingProvider, type KnownField } from './field-context'
import { FieldRows } from './field-row'

const NO_FIELDS: KnownField[] = []
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
  rows = 12,
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
  /** Rows the JSON textarea starts with. */
  rows?: number | undefined
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
      <div className="shrink-0 border-b border-kumo-line px-3 py-2">
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
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5 p-2">
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
          <div className="shrink-0 border-t border-kumo-line px-2 py-1.5">
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
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="grid gap-2 p-3">
            <textarea
              value={json}
              onChange={(event) => setJson(event.target.value)}
              rows={rows}
              spellCheck={false}
              className="w-full resize-y rounded-md bg-kumo-control p-2 font-mono text-[12px] leading-5 text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus"
              aria-label="Document JSON"
              data-testid="document-json"
            />
            {jsonError && (
              <Text variant="error" size="sm">
                {jsonError}
              </Text>
            )}
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={applyJson}>
                Apply to fields
              </Button>
              <Text variant="secondary" size="sm">
                A value JSON cannot write down — a timestamp, a reference, a double that reads whole
                — keeps its type while the JSON still agrees with it.
              </Text>
            </div>
          </div>
        </div>
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
        className="h-7 min-w-0 flex-1 rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring ring-kumo-line outline-none placeholder:font-sans placeholder:text-kumo-inactive focus:ring-kumo-focus"
        aria-label="New field name"
        data-testid="new-field-name"
      />
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              className="group flex h-7 shrink-0 items-center rounded px-0.5 hover:bg-kumo-tint"
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
      <Button
        variant="ghost"
        size="sm"
        icon={<PlusIcon />}
        onClick={() => add(name, type)}
        disabled={!typed}
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
