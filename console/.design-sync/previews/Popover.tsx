import { Button, Popover } from '@firenook/kit'
import { useEffect } from 'react'

/** Opening focuses a control; the card is a still, so the ring is dropped after mount. */
function BlurOnMount() {
  useEffect(() => {
    const id = window.setTimeout(() => (document.activeElement as HTMLElement | null)?.blur(), 60)
    return () => window.clearTimeout(id)
  }, [])
  return null
}

/** A small anchored choice, shown open. */
export function CopyAsCode() {
  return (
    <div className="p-4">
      <BlurOnMount />
      <Popover open>
        <Popover.Trigger render={<Button variant="secondary" />}>Copy as code</Popover.Trigger>
        <Popover.Content className="w-56">
          <Popover.Title>Copy as code</Popover.Title>
          <Popover.Description>The same read in the SDK you use.</Popover.Description>
          <div className="mt-3 grid gap-1">
            <Button variant="ghost" size="sm" className="justify-start">
              Web SDK v10
            </Button>
            <Button variant="ghost" size="sm" className="justify-start">
              Admin SDK
            </Button>
            <Button variant="ghost" size="sm" className="justify-start">
              REST
            </Button>
          </div>
        </Popover.Content>
      </Popover>
    </div>
  )
}
