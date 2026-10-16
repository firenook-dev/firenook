// The auth stream's functions for its journeys. FIXTURE_STREAMS=auth (or unset)
// loads them; index.js throws if an export name is already taken by another
// file. The auth stream owns this file, and only this file holds the
// blocking functions (beforeCreate, beforeSignIn) and the account triggers
// (onUserCreated, onUserDeleted), so compute's journeys load it beside their
// own (FIXTURE_STREAMS=compute,auth).
//
// Both blocking functions let every address through except two test
// domains, so a profile that loads this codebase is otherwise unaffected:
// `@blocked.test` sign-ups are refused with the function's own message, and
// `@claims.test` sign-ins get custom and session claims.

const functions = require('firebase-functions/v1')
const {
  beforeUserCreated,
  beforeUserSignedIn,
  HttpsError,
} = require('firebase-functions/v2/identity')
const { initializeApp, getApps } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

exports.beforeCreate = beforeUserCreated((event) => {
  if (event.data?.email?.endsWith('@blocked.test')) {
    throw new HttpsError('permission-denied', 'Sign-ups from blocked.test are not allowed')
  }
})

exports.beforeSignIn = beforeUserSignedIn((event) =>
  event.data?.email?.endsWith('@claims.test')
    ? { customClaims: { tester: true }, sessionClaims: { session: 'journey' } }
    : {},
)

// v2 has no account-created trigger; the 1st-gen one is what apps use.
exports.onUserCreated = functions.auth.user().onCreate(async (user) => {
  if (!getApps().length) initializeApp()
  await getFirestore()
    .doc(`auth-triggers/${user.uid}`)
    .set({ email: user.email ?? null })
})

// What a delete runs: the Users page names it in every delete dialog, and a
// delete without triggers (Settings' delete-all, a tenant's delete) must
// never reach it. Each run leaves `auth-deletes/<uid>`, so a journey can
// tell that it ran, or that it did not.
exports.onUserDeleted = functions.auth.user().onDelete(async (user) => {
  if (!getApps().length) initializeApp()
  await getFirestore()
    .doc(`auth-deletes/${user.uid}`)
    .set({ email: user.email ?? null })
})
