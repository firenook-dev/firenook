import { Button, DropdownMenu } from '@firenook/kit'
import { DatabaseIcon, KeyIcon, PlusIcon, TrashIcon, UsersIcon } from '@phosphor-icons/react'
import { useEffect } from 'react'

/** Opening focuses a control; the card is a still, so the ring is dropped after mount. */
function BlurOnMount() {
  useEffect(() => {
    const id = window.setTimeout(() => (document.activeElement as HTMLElement | null)?.blur(), 60)
    return () => window.clearTimeout(id)
  }, [])
  return null
}

/** Row actions, shown open. The destructive item is last and red. */
export function RowActions() {
  return (
    <div className="p-4">
      <BlurOnMount />
      <DropdownMenu open>
        <DropdownMenu.Trigger
          render={
            <Button variant="secondary" icon={<PlusIcon />}>
              Actions
            </Button>
          }
        />
        <DropdownMenu.Content>
          <DropdownMenu.Item icon={KeyIcon}>Mint ID token</DropdownMenu.Item>
          <DropdownMenu.Item icon={UsersIcon}>Sign in as this user</DropdownMenu.Item>
          <DropdownMenu.Item icon={DatabaseIcon}>View Firestore as this user</DropdownMenu.Item>
          <DropdownMenu.Item icon={TrashIcon} variant="danger">
            Delete user
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}
