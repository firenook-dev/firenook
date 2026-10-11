// The type of a value, as the control that changes it.
//
// One component for the two places a value is edited — a row of the
// inspector's field tree and a cell of the grid — because they are the
// same act on the same value, and two menus would drift: the grid's used
// to offer nothing at all, so the only way to turn a field into a map was
// to leave the grid for the panel.

import { DropdownMenu } from '@cloudflare/kumo'
import { TypeBadge } from '@/components/kit'
import { type FirestoreValueType, VALUE_TYPES } from '../value'

export function TypeMenu({
  type,
  label,
  onPick,
}: {
  type: FirestoreValueType
  /** What the value is called, for the trigger's accessible name. */
  label: string
  onPick: (type: FirestoreValueType) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="group flex h-6 shrink-0 items-center rounded-md px-1 outline-none hover:bg-kumo-tint focus-visible:ring focus-visible:ring-kumo-focus"
            aria-label={`${label} type: ${type}`}
          >
            <TypeBadge type={type} menu />
          </button>
        }
      />
      <DropdownMenu.Content>
        <DropdownMenu.RadioGroup
          value={type}
          onValueChange={(value) => onPick(value as FirestoreValueType)}
        >
          {VALUE_TYPES.map((item) => (
            <DropdownMenu.RadioItem key={item} value={item} closeOnClick>
              <span className="font-mono text-[12px]">{item}</span>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
