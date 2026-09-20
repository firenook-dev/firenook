import { Text } from '@firenook/kit'

/** Content text is 14 px; 16 px and 20 px are headings. Semibold for headings, medium for emphasis, never bold. */
export function Scale() {
  return (
    <div className="grid gap-2">
      <Text variant="heading" size="lg" as="h1">
        Firestore
      </Text>
      <Text variant="heading" as="h2">
        Recent requests
      </Text>
      <Text>Every section is a screen the console will own.</Text>
      <Text bold>demo-shop-local</Text>
      <Text variant="secondary">Updated 2 minutes ago</Text>
      <Text size="sm">Rows 1–50 of 12,345</Text>
      <Text size="xs">Ctrl K opens the palette</Text>
    </div>
  )
}

/** Paths, ids, values and timestamps set in IBM Plex Mono. */
export function Mono() {
  return (
    <div className="grid gap-2">
      <Text variant="mono">users/u_9f3k2/orders/o_20251</Text>
      <Text variant="mono" size="lg">
        {'{ "status": "paid", "total": 42 }'}
      </Text>
      <Text variant="mono-secondary">2026-09-20T10:14:02.117Z</Text>
      <Text>
        Edit <span className="font-mono text-[0.9em]">firestore.rules</span> to change access.
      </Text>
    </div>
  )
}

export function States() {
  return (
    <div className="grid gap-2">
      <Text variant="success">Saved at revision 4,812</Text>
      <Text variant="error">Permission denied by rules line 14</Text>
      <Text truncate className="max-w-xs">
        users/u_9f3k2/orders/o_20251/events/e_0000000000000000000000001
      </Text>
    </div>
  )
}
