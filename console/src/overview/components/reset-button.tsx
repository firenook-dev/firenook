// The Data card's "Reset data" button: the trigger of the reset menu, and
// the same button drawn while that menu's code is still on its way, so the
// card does not change as it arrives. Its own file, so the landing route
// takes the button without the menu.

import { Button } from '@cloudflare/kumo'
import { ArrowCounterClockwiseIcon, CaretDownIcon } from '@phosphor-icons/react'
import type { ComponentProps } from 'react'

export function ResetButton(props: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="secondary"
      icon={<ArrowCounterClockwiseIcon className="text-kumo-danger" />}
      data-testid="overview-reset-open"
      {...props}
    >
      <span className="flex items-center gap-1.5">
        Reset data
        <CaretDownIcon size={12} className="text-kumo-subtle" aria-hidden />
      </span>
    </Button>
  )
}
