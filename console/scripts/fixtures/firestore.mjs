// Firestore's rules and indexes for the synthetic project. Rules shaped like
// a real app's, so "view as" has denials to show: a user reads their own
// document and everything under it, products are public, and nothing else
// is reachable from a client. One declared composite index, so the console
// can show both answers: a query this project is ready to deploy, and one
// that would fail there.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** @type {import('../synthetic-engine.mjs').Fixture} */
export default {
  name: 'firestore',
  prepare(directory, firebaseJson) {
    writeFileSync(
      join(directory, 'firestore.rules'),
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /users/{uid} {',
        '      allow read: if request.auth != null && request.auth.uid == uid;',
        '      allow write: if false;',
        '      match /{document=**} {',
        '        allow read: if request.auth != null && request.auth.uid == uid;',
        '      }',
        '    }',
        '    match /products/{product} {',
        '      allow read: if true;',
        '    }',
        '    match /{document=**} {',
        '      allow read, write: if false;',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(directory, 'firestore.indexes.json'),
      JSON.stringify(
        {
          indexes: [
            {
              collectionGroup: 'users',
              queryScope: 'COLLECTION',
              fields: [
                { fieldPath: 'plan', order: 'ASCENDING' },
                { fieldPath: 'lastSeen', order: 'DESCENDING' },
              ],
            },
          ],
          fieldOverrides: [],
        },
        null,
        2,
      ),
    )
    firebaseJson.firestore = { rules: 'firestore.rules', indexes: 'firestore.indexes.json' }
  },
}
