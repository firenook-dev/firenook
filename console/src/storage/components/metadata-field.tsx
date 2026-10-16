// One standard metadata field's box, the same wherever metadata is typed:
// the Metadata tab, "Edit metadata" of many files and the upload options.
// The values are free text with suggestions (a type, `public,
// max-age=600`, `attachment; filename="x.png"` are typed as often as
// picked — so Kumo's Autocomplete, not a Combobox that only accepts its
// items), from the one list in `metadata-draft.ts`; a field with nothing
// to suggest is a plain box named by the field.

import { Autocomplete, Input } from '@cloudflare/kumo'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { type StandardField, fieldSuggestions } from '../metadata-draft'

export function MetadataField({
  field,
  value,
  onChange,
  placeholder,
  object,
}: {
  field: StandardField
  value: string
  onChange: (value: string) => void
  placeholder?: string | undefined
  /** The file the value describes, when there is one: its suggestions lead. */
  object?: Pick<StorageObjectDetail, 'name' | 'sniffed'> | undefined
}) {
  const suggestions = fieldSuggestions(field, object)
  if (suggestions.length === 0)
    return (
      <Input
        size="sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={field}
        placeholder={placeholder ?? ''}
        spellCheck={false}
        autoComplete="off"
        className="w-full font-mono"
      />
    )
  return (
    <Autocomplete
      items={suggestions}
      value={value}
      onValueChange={(next) => onChange(String(next ?? ''))}
    >
      <Autocomplete.InputGroup size="sm" className="font-mono" placeholder={placeholder ?? ''} />
      <Autocomplete.Content>
        <Autocomplete.List>
          {(item: string) => (
            <Autocomplete.Item key={item} value={item}>
              <span className="font-mono text-[12px]">{item}</span>
            </Autocomplete.Item>
          )}
        </Autocomplete.List>
      </Autocomplete.Content>
    </Autocomplete>
  )
}
