// One field row in the inspector: name, type, and an editor that matches
// the type. Text is kept as typed and parsed on save so a half-typed value
// never fights the cursor.

import { Button, DropdownMenu, Switch, Tooltip } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, ClockIcon, TrashIcon } from '@phosphor-icons/react'
import { TypeBadge } from '@/components/kit'
import { type FirestoreValueType, VALUE_TYPES, editorText, emptyValue } from '../value'

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
                <DropdownMenu.RadioItem key={type} value={type}>
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
