// The typed field editors shared by the inspector and the create dialog:
// one row per field (name, type, an editor that matches the type), the
// list with its add-field line, and the JSON view that round-trips to it.
// Text is kept as typed and parsed on save so a half-typed value never
// fights the cursor.

import { Button, DropdownMenu, Switch, Tabs, Text, Tooltip } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, ClockIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { TypeBadge } from '@/components/kit'
import {
  type FirestoreValueType,
  type FsDocument,
  type FsValue,
  VALUE_TYPES,
  editorText,
  emptyValue,
  fieldsToJson,
  fromJson,
  parseEditorText,
} from '../value'

export interface FieldDraft {
  name: string
  type: FirestoreValueType
  text: string
  /** Set when the draft differs from the stored value. */
  dirty: boolean
  error?: string | undefined
  added?: boolean | undefined
}

export function draftFor(name: string, type: FirestoreValueType, text: string): FieldDraft {
  return { name, type, text, dirty: false }
}

export function draftsFrom(document: FsDocument, dirty = false): FieldDraft[] {
  return Object.entries(document.fields).map(([name, value]) => ({
    name,
    type: value.type,
    text: editorText(value),
    dirty,
  }))
}

const NO_FIELDS: string[] = []

/** The JSON a draft stands for: timestamps as ISO strings, references as paths. */
export function toJsonValue(value: FsValue): unknown {
  switch (value.type) {
    case 'timestamp':
      return value.value
    case 'reference':
      return value.path
    default:
      return fieldsToJson({ v: value }).v
  }
}

/** The drafts as one JSON object; a draft that does not parse contributes its text. */
export function draftsToJson(drafts: readonly FieldDraft[]): Record<string, unknown> {
  const plain: Record<string, unknown> = {}
  for (const draft of drafts) {
    const parsed = parseEditorText(draft.type, draft.text)
    plain[draft.name] = parsed.ok ? toJsonValue(parsed.value) : draft.text
  }
  return plain
}

/**
 * JSON text → drafts. A stored type survives when JSON cannot express it
 * (timestamps, references) and the text is unchanged; fields missing from
 * the JSON are reported as gone.
 */
export function draftsFromJson(
  text: string,
  current: readonly FieldDraft[],
): { drafts: FieldDraft[]; gone: string[] } {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('The document must be a JSON object')
  const value = fromJson(parsed)
  if (value.type !== 'map') throw new Error('The document must be a JSON object')
  const existing = new Map(current.map((draft) => [draft.name, draft]))
  const drafts: FieldDraft[] = Object.entries(value.fields).map(([name, item]) => {
    const before = existing.get(name)
    const itemText = editorText(item)
    const type: FirestoreValueType = before && itemText === before.text ? before.type : item.type
    const changed = !before || before.text !== itemText || before.type !== type
    return { name, type, text: itemText, dirty: changed, added: !before }
  })
  const gone = current.filter((draft) => !(draft.name in value.fields)).map((draft) => draft.name)
  return { drafts, gone }
}

/**
 * The fields of one document as editable rows with a JSON view beside
 * them. The caller owns the drafts (it saves them); the panel owns the
 * JSON text and the add-field line.
 */
export function FieldsPanel({
  drafts,
  onDraftsChange,
  removed = NO_FIELDS,
  onRemoved,
  tab,
  onTabChange,
  onOpenReference,
  rows = 12,
}: {
  drafts: FieldDraft[]
  onDraftsChange: (next: FieldDraft[]) => void
  /** Fields the caller will delete on save (the inspector); shown as a note. */
  removed?: string[] | undefined
  onRemoved?: ((names: string[]) => void) | undefined
  tab: 'fields' | 'json'
  onTabChange: (tab: 'fields' | 'json') => void
  onOpenReference: (path: string) => void
  /** Rows the JSON textarea starts with. */
  rows?: number | undefined
}) {
  const [json, setJson] = useState('')
  const [jsonTab, setJsonTab] = useState<'fields' | 'json'>('fields')
  const [jsonError, setJsonError] = useState<string | undefined>()
  const [newField, setNewField] = useState('')

  // Opening the JSON tab shows the drafts as they are now (derived in render).
  if (tab !== jsonTab) {
    setJsonTab(tab)
    if (tab === 'json') {
      setJson(JSON.stringify(draftsToJson(drafts), null, 2))
      setJsonError(undefined)
    }
  }

  const applyJson = () => {
    try {
      const next = draftsFromJson(json, drafts)
      onDraftsChange(next.drafts)
      if (next.gone.length > 0) onRemoved?.(next.gone)
      setJsonError(undefined)
      onTabChange('fields')
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error))
    }
  }

  const addField = () => {
    const name = newField.trim()
    if (!name || drafts.some((draft) => draft.name === name)) return
    onDraftsChange([...drafts, { ...draftFor(name, 'string', ''), dirty: true, added: true }])
    setNewField('')
  }

  return (
    <>
      <div className="shrink-0 border-b border-kumo-line px-3 py-2">
        <Tabs
          size="sm"
          variant="segmented"
          value={tab}
          onValueChange={(value) => onTabChange(value as 'fields' | 'json')}
          tabs={[
            { value: 'fields', label: `Fields · ${drafts.length}` },
            { value: 'json', label: 'JSON' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'fields' ? (
          <div className="grid gap-0.5 p-2">
            {drafts.map((draft, index) => (
              <FieldEditor
                key={draft.name}
                draft={draft}
                onChange={(next) =>
                  onDraftsChange(drafts.map((item, i) => (i === index ? next : item)))
                }
                onRemove={() => {
                  onDraftsChange(drafts.filter((_, i) => i !== index))
                  if (!draft.added) onRemoved?.([draft.name])
                }}
                onOpenReference={onOpenReference}
              />
            ))}
            {drafts.length === 0 && (
              <div className="px-2 py-1">
                <Text variant="secondary" size="sm">
                  No fields yet.
                </Text>
              </div>
            )}
            {removed.length > 0 && (
              <div className="px-2 py-1">
                <Text variant="secondary" size="sm">
                  Removing {removed.join(', ')} on save
                </Text>
              </div>
            )}
            <div className="flex items-center gap-1 px-2 pt-2">
              <input
                value={newField}
                onChange={(event) => setNewField(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addField()
                  }
                }}
                placeholder="New field name"
                spellCheck={false}
                className="h-7 min-w-0 flex-1 rounded-md bg-kumo-control px-2 font-mono text-[12px] text-kumo-default ring ring-kumo-line outline-none placeholder:font-sans placeholder:text-kumo-inactive focus:ring-kumo-focus"
                aria-label="New field name"
                data-testid="new-field-name"
              />
              <Button
                variant="ghost"
                size="sm"
                icon={<PlusIcon />}
                onClick={addField}
                disabled={!newField.trim()}
              >
                Add field
              </Button>
            </div>
          </div>
        ) : (
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
                Timestamps and references keep their type when unchanged.
              </Text>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export function FieldEditor({
  draft,
  onChange,
  onRemove,
  onOpenReference,
}: {
  draft: FieldDraft
  onChange: (next: FieldDraft) => void
  onRemove: () => void
  onOpenReference: (path: string) => void
}) {
  const changeType = (type: FirestoreValueType) => {
    // Keep the text when the new type can read it; otherwise start empty.
    const keep =
      type === 'string' || type === 'number' || type === 'timestamp' || type === 'reference'
    onChange({
      ...draft,
      type,
      text: keep ? draft.text : editorText(emptyValue(type)),
      dirty: true,
      error: undefined,
    })
  }
  const setText = (text: string) => onChange({ ...draft, text, dirty: true, error: undefined })
  const mono = 'font-mono text-[12px]'
  const inputClass = `h-7 w-full rounded-md bg-kumo-control px-2 text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus ${
    draft.error ? 'ring-kumo-danger' : ''
  }`

  let editor: React.ReactNode
  switch (draft.type) {
    case 'boolean':
      editor = (
        <div className="flex h-7 items-center">
          <Switch
            variant="neutral"
            size="sm"
            checked={draft.text === 'true'}
            onClick={() => setText(draft.text === 'true' ? 'false' : 'true')}
            aria-label={`${draft.name} value`}
          />
          <span className={`ml-2 ${mono} text-kumo-subtle`}>{draft.text}</span>
        </div>
      )
      break
    case 'null':
      editor = <span className={`${mono} flex h-7 items-center text-kumo-inactive`}>null</span>
      break
    case 'map':
    case 'array':
    case 'vector':
      editor = (
        <textarea
          value={draft.text}
          onChange={(event) => setText(event.target.value)}
          rows={Math.min(12, Math.max(2, draft.text.split('\n').length))}
          spellCheck={false}
          className={`w-full resize-y rounded-md bg-kumo-control px-2 py-1 ${mono} leading-5 text-kumo-default ring ring-kumo-line outline-none focus:ring-kumo-focus ${
            draft.error ? 'ring-kumo-danger' : ''
          }`}
          aria-label={`${draft.name} value`}
        />
      )
      break
    case 'timestamp':
      editor = (
        <div className="flex items-center gap-1">
          <input
            value={draft.text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            className={`${inputClass} ${mono}`}
            aria-label={`${draft.name} value`}
          />
          <Tooltip
            content="Now"
            render={
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={<ClockIcon />}
                aria-label="Set to now"
                onClick={() => setText(new Date().toISOString())}
              />
            }
          />
        </div>
      )
      break
    case 'reference':
      editor = (
        <div className="flex items-center gap-1">
          <input
            value={draft.text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            className={`${inputClass} ${mono}`}
            aria-label={`${draft.name} value`}
          />
          <Tooltip
            content="Open the referenced document"
            render={
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                icon={<ArrowSquareOutIcon />}
                aria-label="Open the referenced document"
                onClick={() => onOpenReference(draft.text)}
              />
            }
          />
        </div>
      )
      break
    default:
      editor = (
        <input
          value={draft.text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          className={`${inputClass} ${draft.type === 'string' ? '' : mono}`}
          aria-label={`${draft.name} value`}
        />
      )
  }

  return (
    <div
      className={`grid gap-1 rounded-md px-2 py-1.5 ${draft.dirty ? 'bg-kumo-tint' : ''}`}
      data-testid="field-row"
    >
      <div className="flex items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium"
          title={draft.name}
        >
          {draft.name}
        </span>
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                type="button"
                className="flex h-5 items-center rounded px-0.5 hover:bg-kumo-tint"
                aria-label={`${draft.name} type: ${draft.type}`}
              >
                <TypeBadge type={draft.type} />
              </button>
            }
          />
          <DropdownMenu.Content>
            <DropdownMenu.RadioGroup
              value={draft.type}
              onValueChange={(value) => changeType(value as FirestoreValueType)}
            >
              {VALUE_TYPES.map((type) => (
                <DropdownMenu.RadioItem key={type} value={type} closeOnClick>
                  <span className="font-mono text-[12px]">{type}</span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu>
        <Tooltip
          content="Remove field"
          render={
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              icon={<TrashIcon />}
              aria-label={`Remove ${draft.name}`}
              onClick={onRemove}
            />
          }
        />
      </div>
      {editor}
      {draft.error && <span className="text-[12px] text-kumo-danger">{draft.error}</span>}
    </div>
  )
}
