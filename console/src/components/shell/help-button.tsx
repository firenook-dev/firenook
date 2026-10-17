// The top bar's "?": the trigger of the help menu, and the same button
// drawn while that menu's code is on its way, so the bar does not change
// as it arrives. Its own file, so the first route takes the button
// without the menu.

import { QuestionIcon } from '@phosphor-icons/react'
import type { ComponentProps } from 'react'

export function HelpButton(props: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label="Help"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-kumo-subtle outline-none hover:ink hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus data-[popup-open]:ink data-[popup-open]:text-kumo-default"
      data-testid="top-bar-help"
      {...props}
    >
      <QuestionIcon size={17} aria-hidden />
    </button>
  )
}
