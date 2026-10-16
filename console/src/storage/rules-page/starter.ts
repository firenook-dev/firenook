// Starter rules for Storage: a few templates for the shapes most apps have,
// and a block written from what a folder of the bucket actually holds.
//
// From the data, said to be a guess: when the folder's subfolders are named
// after Auth users, each user owns theirs (`{uid}`); uploads are held to the
// type family every file there shares (`image/.*` when they are all images,
// one exact type when there is only one) and to a size limit of twice the
// typical file, rounded up to a whole megabyte, so the files already there
// would pass and a stray video would not.

import type { StorageProfile } from '@/api/generated/storage/StorageProfile'

const MB = 1024 * 1024

export interface StarterTemplate {
  id: string
  title: string
  /** The files it governs, as a path. */
  path: string
  description: string
  /** The match block, indented for inside `match /b/{bucket}/o`. */
  block: string
}

function indent(lines: readonly string[], by = '    '): string {
  return lines.map((line) => (line ? `${by}${line}` : line)).join('\n')
}

/** The shapes most apps start from. */
export const TEMPLATES: readonly StarterTemplate[] = [
  {
    id: 'owner',
    title: 'Each user’s own folder',
    path: 'users/{uid}/…',
    description: 'A signed-in user reads and writes their folder, files under 10 MB.',
    block: indent([
      '// Each signed-in user reads and writes their own folder, files under 10 MB.',
      'match /users/{uid}/{allPaths=**} {',
      '  allow read: if request.auth != null && request.auth.uid == uid;',
      '  allow write: if request.auth != null && request.auth.uid == uid',
      '    && request.resource.size < 10 * 1024 * 1024;',
      '}',
    ]),
  },
  {
    id: 'public',
    title: 'Public files, uploaded by signed-in users',
    path: 'public/…',
    description: 'Anyone reads; a signed-in user uploads files under 10 MB.',
    block: indent([
      '// Anyone reads; a signed-in user uploads, files under 10 MB.',
      'match /public/{allPaths=**} {',
      '  allow read;',
      '  allow write: if request.auth != null',
      '    && request.resource.size < 10 * 1024 * 1024;',
      '}',
    ]),
  },
  {
    id: 'images',
    title: 'Profile images',
    path: 'images/{uid}/{image}',
    description: 'Signed-in users read; each owner uploads images under 5 MB.',
    block: indent([
      '// Signed-in users see the images; each user uploads their own, images under 5 MB.',
      'match /images/{uid}/{image} {',
      '  allow read: if request.auth != null;',
      '  allow create, update: if request.auth != null && request.auth.uid == uid',
      '    && request.resource.size < 5 * 1024 * 1024',
      "    && request.resource.contentType.matches('image/.*');",
      '  allow delete: if request.auth != null && request.auth.uid == uid;',
      '}',
    ]),
  },
  {
    id: 'read-only',
    title: 'Read-only files',
    path: 'assets/…',
    description: 'Anyone reads; only the Admin SDK writes.',
    block: indent([
      '// Anyone reads; nothing writes but the Admin SDK, which skips the rules.',
      'match /assets/{allPaths=**} {',
      '  allow read;',
      '}',
    ]),
  },
]

/** The size limit for uploads of a folder: twice its typical file, a whole megabyte at least. */
export function sizeLimitMb(profile: Pick<StorageProfile, 'typicalSize' | 'objects'>): number {
  if (profile.objects === 0) return 10
  return Math.max(1, Math.ceil((profile.typicalSize * 2) / MB))
}

/** The content type check every file in the folder would pass, and how it reads; none when they differ. */
export function typeRule(
  profile: Pick<StorageProfile, 'contentTypes'>,
): { check: string; said: string } | undefined {
  const types = profile.contentTypes.map((entry) => entry.contentType).filter(Boolean)
  if (types.length === 0) return undefined
  if (types.length === 1)
    return {
      check: `request.resource.contentType == '${types[0]}'`,
      said: `${types[0]} only, the one type there`,
    }
  const families = new Set(types.map((type) => type.split('/')[0]))
  if (families.size !== 1) return undefined
  const [family] = families
  return {
    check: `request.resource.contentType.matches('${family}/.*')`,
    said: `${family}/* only, as every file there is`,
  }
}

/** The check alone. */
export function typeCheck(profile: Pick<StorageProfile, 'contentTypes'>): string | undefined {
  return typeRule(profile)?.check
}

/**
 * A match block for a folder pattern of the map (`misc/`, `users/` + a star
 * segment + `/`), written from the folder's profile and the uids of the
 * project's Auth users.
 */
export function starterFromData(
  pattern: string,
  profile: StorageProfile,
  uids: ReadonlySet<string>,
): string {
  const segments = pattern.split('/').filter((segment) => segment !== '')
  let stars = 0
  const parts = segments.map((segment) => {
    if (segment !== '*') return segment
    stars += 1
    return stars === 1 ? '{folder}' : `{folder${stars}}`
  })
  const owners = profile.childFolders.filter((folder) => uids.has(folder))
  const owned = owners.length > 0
  if (owned) parts.push('{uid}')
  // Files at the bucket's root only: a recursive match there would govern
  // every file of the bucket.
  parts.push(parts.length === 0 ? '{file}' : '{allPaths=**}')
  const signedIn = owned
    ? 'request.auth != null && request.auth.uid == uid'
    : 'request.auth != null'
  const limit = sizeLimitMb(profile)
  const rule = typeRule(profile)
  const type = rule?.check
  const where = pattern === '' ? 'the bucket’s root' : pattern
  const guesses = [
    owned
      ? `${owners.length} of its folders are named after Auth users, so each user owns theirs`
      : 'nothing says who owns these files, so any signed-in user can; narrow this',
    `uploads under ${limit} MB, twice the typical file`,
    ...(rule ? [`uploads of ${rule.said}`] : []),
  ]
  const lines = [
    `// Starter rules for ${where}, from ${profile.objects} file${profile.objects === 1 ? '' : 's'}${profile.sampled ? ' (sampled)' : ''}.`,
    `// A guess: ${guesses.join('; ')}. Check it before relying on it.`,
    `match /${parts.join('/')} {`,
    `  allow read: if ${signedIn};`,
    `  allow create: if ${signedIn}`,
    `    && request.resource.size < ${limit} * 1024 * 1024${type ? '' : ';'}`,
    ...(type ? [`    && ${type};`] : []),
    `  allow update, delete: if ${signedIn};`,
    '}',
  ]
  return indent(lines)
}

/**
 * The folder patterns worth a starter block: the uncovered ones whose files
 * no rule governs, leaving out any below another of them (a block for
 * `misc/` covers everything under it).
 */
export function uncoveredRoots(
  folders: ReadonlyArray<{ pattern: string; uncovered: boolean }>,
): string[] {
  const uncovered = folders.filter((folder) => folder.uncovered).map((folder) => folder.pattern)
  return uncovered.filter(
    (pattern) =>
      !uncovered.some((other) => other !== pattern && other !== '' && pattern.startsWith(other)),
  )
}
