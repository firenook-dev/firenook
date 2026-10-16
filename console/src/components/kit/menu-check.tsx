// The tick on a chosen menu item. Kumo's own `selected` renders it hard
// against the label, with nothing between the word and the mark; this one
// sits at the item's right edge, where a menu is read.
//
// The gap goes on a wrapper, not the icon: a Phosphor icon carries width
// and height attributes, so padding eats the glyph rather than moving it.

import { CheckIcon } from '@phosphor-icons/react'

export function MenuCheck({ on }: { on: boolean }) {
  return on ? (
    <span className="ml-auto flex shrink-0 items-center pl-3 text-kumo-brand">
      <CheckIcon size={13} />
    </span>
  ) : null
}
