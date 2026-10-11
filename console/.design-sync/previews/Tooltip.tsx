import { Button, Text, Tooltip, TooltipProvider } from '@firenook/kit'
import { ArrowsClockwiseIcon } from '@phosphor-icons/react'

/** Every icon-only button carries a tooltip naming its action; wrap a region in TooltipProvider so hovering across buttons skips the delay. */
export function IconButton() {
  return (
    <TooltipProvider>
      <div className="flex items-center gap-3 p-4">
        <Tooltip
          content="Reload rules from disk"
          render={
            <Button
              shape="square"
              variant="secondary"
              icon={<ArrowsClockwiseIcon />}
              aria-label="Reload rules"
            />
          }
        />
        <Text variant="secondary" size="sm">
          Hover: “Reload rules from disk”
        </Text>
      </div>
    </TooltipProvider>
  )
}
