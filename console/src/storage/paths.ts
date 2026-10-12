// Object names and folders as GCS has them: a folder is a prefix ending in
// `/`, the bucket root is `''`, and a name may hold `//` or start with `/`
// (`a//b.png`, `/lead.png`), so an empty segment is a folder of its own and
// is never collapsed. Pure string helpers, small enough for the registry
// file, which loads with the first route.

/** The folder holding an object: everything up to its last `/`; `''` at the root. */
export function parentOf(name: string): string {
  return name.slice(0, name.lastIndexOf('/') + 1)
}

/** The folder above a folder: `users/u1/` → `users/`; the root has none and stays `''`. */
export function parentFolder(prefix: string): string {
  return prefix === '' ? '' : parentOf(prefix.slice(0, -1))
}

/** A folder as the console writes it: `''` for the root, else ending in `/`. Nothing is collapsed. */
export function normalizeFolder(raw: string): string {
  return raw === '' || raw.endsWith('/') ? raw : `${raw}/`
}

/**
 * Every folder a name sits in, the root first: `a/b/c.png` → `''`, `a/`,
 * `a/b/`. A folder marker (`a/b/`) lists its own folder last, since the
 * marker is what makes it exist.
 */
export function foldersOf(name: string): string[] {
  const out = ['']
  for (let index = name.indexOf('/'); index !== -1; index = name.indexOf('/', index + 1))
    out.push(name.slice(0, index + 1))
  return out
}

/**
 * The row a name is in a folder's listing: the object itself when it sits
 * directly in `prefix`, the subfolder holding it when it is deeper, and
 * nothing when it is outside `prefix` or is `prefix`'s own marker.
 */
export function rowKeyIn(prefix: string, name: string): string | undefined {
  if (!name.startsWith(prefix)) return undefined
  const rest = name.slice(prefix.length)
  if (rest === '') return undefined
  const slash = rest.indexOf('/')
  return slash === -1 ? name : prefix + rest.slice(0, slash + 1)
}
