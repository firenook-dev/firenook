// Storage rules for the synthetic project: anyone reads under `public/`,
// and each signed-in user reads and writes their own folder (`users/<uid>/`)
// and nothing else. The storage stream may extend this file.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'storage',
  prepare(directory, firebaseJson) {
    writeFileSync(
      join(directory, 'storage.rules'),
      [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /public/{path=**} {',
        '      allow read: if true;',
        '      allow write: if false;',
        '    }',
        '    match /users/{uid}/{path=**} {',
        '      allow read, write: if request.auth != null && request.auth.uid == uid;',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    firebaseJson.storage = { rules: 'storage.rules' }
  },
}
