// What `doc=` in the address names. A link from the grid always writes a
// document's whole path (`orders/x`), but a person typing an address, or a
// tool building one, often writes the id alone (`doc=x`) beside the
// collection in `path=`. A bare id is read against that collection; any
// other value that is not a document's path (a collection, an id at the
// root, an id in a collection group, which spans many collections) is kept
// as written, so the panel can say it names no document rather than ask
// the engine for it.

/** Whether `path` names a document: an even, non-zero number of non-empty segments. */
export function isDocumentPath(path: string): boolean {
  const segments = path.split('/')
  return segments.length % 2 === 0 && segments.every((segment) => segment !== '')
}

/**
 * The document `doc` names, with slashes at either end and doubled ones
 * taken out: its whole path as written, or a bare id under the open
 * collection. `undefined` for no `doc` at all. The answer is not always a
 * document's path: check it with `isDocumentPath`.
 */
export function resolveDocument(
  doc: string | undefined,
  view: {
    /** The collection the grid shows; empty at the root. */
    collectionPath: string
    /** Whether the grid shows a collection group, whose rows live in many collections. */
    group: boolean
  },
): string | undefined {
  if (doc === undefined) return undefined
  const path = doc.split('/').filter(Boolean).join('/')
  if (path === '') return undefined
  if (isDocumentPath(path)) return path
  const bare = !path.includes('/')
  if (bare && view.collectionPath !== '' && !view.group) return `${view.collectionPath}/${path}`
  return path
}

/**
 * A document path like the one `doc=` may have meant, for the panel to
 * show: the collection on screen (or `orders`) and the id written.
 */
export function documentExample(path: string, collectionPath: string): string {
  const id = path.split('/').at(-1) ?? path
  // A pattern (`users/*/orders`) is no collection to name; its last id is.
  const collection = collectionPath.includes('*')
    ? (collectionPath.split('/').at(-1) ?? '')
    : collectionPath
  return `${collection === '' ? 'orders' : collection}/${id}`
}
