import { Button, Empty } from '@firenook/kit'
import { DatabaseIcon, PlusIcon, UsersIcon } from '@phosphor-icons/react'

/** Says what is missing and offers the one next step, with a copyable command when there is one. */
export function WithCommand() {
  return (
    <Empty
      icon={<DatabaseIcon size={48} className="text-kumo-inactive" />}
      title="No documents in orders"
      description="Write one from your app, or add a document here."
      commandLine="firenook firestore:seed orders"
      contents={
        <Button variant="primary" icon={<PlusIcon />}>
          Add document
        </Button>
      }
    />
  )
}

export function Small() {
  return (
    <Empty
      size="sm"
      icon={<UsersIcon size={32} className="text-kumo-inactive" />}
      title="No users yet"
      description="Sign one up from your app or add a test user."
    />
  )
}
