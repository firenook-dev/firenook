// Pure helpers for entity keys (foundation spec §7.24), small enough for the
// registry files, which load with the first route.
//
// A key splits at its first `|`, or at its first three for `tasks.task`:
// every leading part is an id that cannot contain `|`, so the last part may
// hold anything — an object name or a document path with a `|` in it
// survives the split.

/**
 * `key` cut into at most `parts` pieces at its first `parts - 1` bars; a key
 * with fewer bars gives fewer pieces, and the caller decides whether that is
 * a key it knows.
 */
export function splitKey(key: string, parts = 2): string[] {
  const pieces: string[] = []
  let rest = key
  while (pieces.length < parts - 1) {
    const bar = rest.indexOf('|')
    if (bar === -1) break
    pieces.push(rest.slice(0, bar))
    rest = rest.slice(bar + 1)
  }
  pieces.push(rest)
  return pieces
}

/** The parent of a document path: `users/u1/orders/o1` → `users/u1/orders`. */
export function parentPath(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments.slice(0, -1).join('/')
}
