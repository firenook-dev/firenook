import { modeWord } from '../indexes'

/** An index's fields in its order, each with its mode: `status ↑` `total ↓`. */
export function FieldChips({
  fields,
  background = 'tint',
}: {
  fields: readonly { fieldPath: string; mode: string; dimension: number | null }[]
  /** The chips' own colour: `base` on a tinted row, so they stand out from it. */
  background?: 'tint' | 'base'
}) {
  return (
    <>
      {fields.map((field) => (
        <span
          key={`${field.fieldPath}|${field.mode}`}
          className={`flex h-5 shrink-0 items-center rounded px-1.5 font-mono text-[11px] text-kumo-default ${
            background === 'base' ? 'bg-kumo-base' : 'bg-kumo-tint'
          }`}
        >
          {field.fieldPath}
          <span className="pl-1 text-kumo-subtle">{modeWord(field)}</span>
        </span>
      ))}
    </>
  )
}
