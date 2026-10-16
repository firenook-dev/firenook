// Object names and folders as GCS has them: a folder is a prefix ending in
// `/`, the bucket root is `''`, and a name may hold `//` or start with `/`
// (`a//b.png`, `/lead.png`), so an empty segment is a folder of its own and
// is never collapsed. Pure string helpers, small enough for the registry
// file, which loads with the first route.

/** The folder holding an object: everything up to its last `/`; `''` at the root. */
export function parentOf(name: string): string {
  return name.slice(0, name.lastIndexOf('/') + 1)
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

/** One step of a folder's path: what it is called and the folder it opens. */
export interface PathSegment {
  /** The segment's name; `''` for an empty segment (`a//`), drawn as `(empty)`. */
  label: string
  /** The folder it opens, ending in `/`. */
  prefix: string
}

/**
 * The steps to a folder, the root left out: `users/u1/` → `users`, `u1`;
 * `a//` → `a`, an empty one; `/` → one empty one. Nothing is collapsed, so
 * every folder GCS allows can be walked to.
 */
export function segments(prefix: string): PathSegment[] {
  const out: PathSegment[] = []
  let start = 0
  for (let index = prefix.indexOf('/'); index !== -1; index = prefix.indexOf('/', index + 1)) {
    out.push({ label: prefix.slice(start, index), prefix: prefix.slice(0, index + 1) })
    start = index + 1
  }
  return out
}

/** The last segment of a name: `users/u1/avatar.png` → `avatar.png`; a folder's without its slash. */
export function baseName(name: string): string {
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** A name as a list below `prefix` shows it: `users/u1/avatar.png` under `users/` → `u1/avatar.png`. */
export function relativeName(name: string, prefix: string): string {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/** `gs://<bucket>/<name>`: what `ref(storage, url)` and gsutil take. */
export function gsUrl(bucket: string, name = ''): string {
  return `gs://${bucket}/${name}`
}

/** An object name as a URL path segment: every `/` encoded, as the protocol writes it. */
export function encodeObjectPath(name: string): string {
  return encodeURIComponent(name)
}

/** Where a pasted or typed location points: a bucket and an object name or a folder (ending in `/`). */
export interface StorageLocation {
  bucket: string
  /** An object name, a folder ending in `/`, or `''` for the bucket root. */
  path: string
}

function decodeSegment(text: string): string | undefined {
  try {
    return decodeURIComponent(text)
  } catch {
    return undefined
  }
}

/** The URL forms the protocol and the GCS APIs use, each with the bucket and the encoded name. */
const URL_FORMS: readonly RegExp[] = [
  // Firebase download URLs, production and emulator: /v0/b/<bucket>/o/<name>?alt=media&token=…
  /^\/v0\/b\/([^/]+)\/o\/?(.*)$/,
  // The JSON API: /storage/v1/b/<bucket>/o/<name>, and its download twin.
  /^\/(?:download\/)?storage\/v1\/b\/([^/]+)\/o\/?(.*)$/,
]

/**
 * The bucket and path a pasted or typed text names, or `undefined` when it
 * names none: `gs://b/p`, a Firebase download URL (production or an
 * emulator's, `%2F` and all), a JSON API URL, `storage.googleapis.com/b/p`,
 * `b/p` when `b` is a bucket the engine knows, and a bare path in the bucket
 * on screen.
 */
export function parseLocation(
  raw: string,
  context: { buckets: readonly string[]; bucket: string },
): StorageLocation | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const gs = /^gs:\/\/([^/]+)\/?(.*)$/s.exec(text)
  if (gs) return { bucket: gs[1] ?? '', path: gs[2] ?? '' }
  if (/^https?:\/\//i.test(text) || /^(firebasestorage|storage)\.googleapis\.com\//i.test(text)) {
    let url: URL
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
    } catch {
      return undefined
    }
    // The console's media route names the object in its params.
    if (
      url.pathname.endsWith('/storage/object/media') ||
      url.pathname.endsWith('/storage/object')
    ) {
      const bucket = url.searchParams.get('bucket')
      const name = url.searchParams.get('name')
      return bucket && name !== null ? { bucket, path: name } : undefined
    }
    // Behind a proxy or a console mount the protocol's path may sit under a prefix.
    const at = url.pathname.search(/\/(v0\/b\/|(download\/)?storage\/v1\/b\/)/)
    const path = at === -1 ? url.pathname : url.pathname.slice(at)
    for (const form of URL_FORMS) {
      const match = form.exec(path)
      if (!match) continue
      const name = decodeSegment(match[2] ?? '')
      return name === undefined ? undefined : { bucket: match[1] ?? '', path: name }
    }
    if (
      /^storage\.googleapis\.com$/i.test(url.host) ||
      /\.storage\.googleapis\.com$/i.test(url.host)
    ) {
      const virtual = /^(.+)\.storage\.googleapis\.com$/i.exec(url.host)
      if (virtual) {
        const name = decodeSegment(url.pathname.slice(1))
        return name === undefined ? undefined : { bucket: virtual[1] ?? '', path: name }
      }
      const rest = url.pathname.slice(1)
      const slash = rest.indexOf('/')
      const bucket = slash === -1 ? rest : rest.slice(0, slash)
      const name = decodeSegment(slash === -1 ? '' : rest.slice(slash + 1))
      return bucket && name !== undefined ? { bucket, path: name } : undefined
    }
    return undefined
  }
  const slash = text.indexOf('/')
  if (slash > 0) {
    const first = text.slice(0, slash)
    if (context.buckets.includes(first)) return { bucket: first, path: text.slice(slash + 1) }
  }
  if (context.buckets.includes(text)) return { bucket: text, path: '' }
  return { bucket: context.bucket, path: text }
}

/**
 * A name cut for a middle truncation that keeps the extension: the head
 * gives way first (`banner-very-long-…07.png`), so the part that tells two
 * files apart stays. Drawn as a truncating head and a fixed tail.
 */
export function truncationParts(name: string): [head: string, tail: string] {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 8 ? name.length - dot : 0
  const keep = Math.min(Math.floor(name.length / 2), extension + 4)
  if (keep <= 0 || name.length <= 12) return [name, '']
  return [name.slice(0, name.length - keep), name.slice(name.length - keep)]
}
