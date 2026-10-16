import { Breadcrumbs } from '@firenook/kit'
import { DatabaseIcon } from '@phosphor-icons/react'

/** A Firestore path as breadcrumbs: the service, then each segment, the current one last. */
export function Path() {
  return (
    <Breadcrumbs>
      <Breadcrumbs.Link href="#" icon={<DatabaseIcon size={16} />}>
        Firestore
      </Breadcrumbs.Link>
      <Breadcrumbs.Separator />
      <Breadcrumbs.Link href="#">users</Breadcrumbs.Link>
      <Breadcrumbs.Separator />
      <Breadcrumbs.Link href="#">u_9f3k2</Breadcrumbs.Link>
      <Breadcrumbs.Separator />
      <Breadcrumbs.Current>orders</Breadcrumbs.Current>
    </Breadcrumbs>
  )
}

export function Small() {
  return (
    <Breadcrumbs size="sm">
      <Breadcrumbs.Link href="#">Authentication</Breadcrumbs.Link>
      <Breadcrumbs.Separator />
      <Breadcrumbs.Link href="#">Users</Breadcrumbs.Link>
      <Breadcrumbs.Separator />
      <Breadcrumbs.Current>ada@example.test</Breadcrumbs.Current>
    </Breadcrumbs>
  )
}
