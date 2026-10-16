import { Button, Dialog } from '@firenook/kit'
import { TrashIcon, XIcon } from '@phosphor-icons/react'
import { useEffect } from 'react'

/** Opening focuses a control; the card is a still, so the ring is dropped after mount. */
function BlurOnMount() {
  useEffect(() => {
    const id = window.setTimeout(() => (document.activeElement as HTMLElement | null)?.blur(), 60)
    return () => window.clearTimeout(id)
  }, [])
  return null
}

/** A confirmation: the title says the action and the primary button repeats it. */
export function Confirm() {
  return (
    <Dialog.Root open>
      <BlurOnMount />
      <Dialog size="base" className="p-6">
        <div className="mb-3 flex items-start justify-between gap-4">
          <Dialog.Title className="text-lg font-semibold">Delete 3 documents</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            render={<Button variant="ghost" shape="square" icon={<XIcon />} aria-label="Close" />}
          />
        </div>
        <Dialog.Description className="text-kumo-subtle">
          orders/o_20249, o_20248 and o_20247 and their subcollections will be removed. Undo stays
          available for the next 5 minutes.
        </Dialog.Description>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary">Cancel</Button>
          <Button variant="destructive" icon={<TrashIcon />}>
            Delete 3 documents
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
