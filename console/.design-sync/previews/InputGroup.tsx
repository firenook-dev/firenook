import { InputGroup } from '@firenook/kit'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'

/** An input with an addon, such as a search icon or a unit. */
export function WithAddon() {
  return (
    <div className="max-w-sm">
      <InputGroup aria-label="Search users">
        <InputGroup.Addon>
          <MagnifyingGlassIcon />
        </InputGroup.Addon>
        <InputGroup.Input placeholder="Search by email, phone or uid" />
      </InputGroup>
    </div>
  )
}
