import { Link, Text } from '@firenook/kit'

/** Links take the ember accent. Inline links sit in running text; plain links drop the underline; current inherits its colour. */
export function Variants() {
  return (
    <div className="grid gap-2">
      <Text>
        Open <Link href="#">users/u_9f3k2</Link> to see the customer.
      </Text>
      <Link href="#" variant="plain">
        Plain link
      </Link>
      <Text variant="secondary">
        A{' '}
        <Link href="#" variant="current">
          current link
        </Link>{' '}
        keeps the surrounding colour.
      </Text>
    </div>
  )
}
