// Storage rules for the synthetic project, as a real project declares them.
//
// By default one rules file per bucket, the way `firebase.json` targets do
// it: `storage.rules` governs the default bucket and `storage.media.rules`
// the media bucket, and the project's `.firebaserc` names which bucket each
// target is. `fixtureEnv.STORAGE_RULES_MODE` switches the shape: `single` is
// one file for every bucket, `none` leaves `storage` out of firebase.json, so
// a `demo-` project gets the emulator's open default rules. The storage
// stream owns this file.
//
// The default bucket's rules are the journeys' subject: each user reads and
// writes their own folder (images under 5 MB), anyone reads `public/`, and
// `reports/` asks Firestore whether the reader's plan is `pro`.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The default bucket's rules; journeys name their lines (the write allow is line 6). */
export const STORAGE_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /users/{uid}/{allPaths=**} {',
  '      allow read: if request.auth != null && request.auth.uid == uid;',
  '      allow write: if request.auth != null && request.auth.uid == uid',
  '        && request.resource.size < 5 * 1024 * 1024',
  "        && request.resource.contentType.matches('image/.*');",
  '    }',
  '    match /public/{allPaths=**} {',
  '      allow read;',
  '    }',
  '    match /reports/{report} {',
  "      allow read: if firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.plan == 'pro';",
  '    }',
  '  }',
  '}',
  '',
].join('\n')

/** The media bucket's rules: anyone reads, any signed-in user writes. */
export const STORAGE_MEDIA_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /{allPaths=**} {',
  '      allow read;',
  '      allow write: if request.auth != null;',
  '    }',
  '  }',
  '}',
  '',
].join('\n')

/** The two buckets of a project in the default (per-bucket) shape. */
export function storageBuckets(project) {
  return { default: `${project}.appspot.com`, media: `${project}-media` }
}

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'storage',
  prepare(directory, firebaseJson, { fixtureEnv, project, firebaseRc }) {
    const mode = fixtureEnv.STORAGE_RULES_MODE ?? 'per-bucket'
    if (mode === 'none') {
      // The emulator is asked for, but no rules are named: a demo project's
      // open default.
      const emulators = /** @type {Record<string, unknown>} */ (firebaseJson.emulators ?? {})
      firebaseJson.emulators = { ...emulators, storage: {} }
      return
    }
    writeFileSync(join(directory, 'storage.rules'), STORAGE_RULES)
    if (mode === 'single') {
      firebaseJson.storage = { rules: 'storage.rules' }
      return
    }
    writeFileSync(join(directory, 'storage.media.rules'), STORAGE_MEDIA_RULES)
    firebaseJson.storage = [
      { target: 'default', rules: 'storage.rules' },
      { target: 'media', rules: 'storage.media.rules' },
    ]
    const buckets = storageBuckets(project)
    firebaseRc.targets = {
      ...firebaseRc.targets,
      [project]: {
        ...firebaseRc.targets?.[project],
        storage: { default: [buckets.default], media: [buckets.media] },
      },
    }
  },
}
