// The storage stream's functions for its journeys. FIXTURE_STREAMS=storage (or unset)
// loads them; index.js throws if an export name is already taken by another
// file. The storage stream owns this file.
//
// `storageFinalized` is what an app's thumbnailer or indexer looks like: a
// v2 function on the default bucket's finalize event. Each run records the
// event in Firestore (`storageEvents/<event id>`), so a journey can tell
// that an upload reached it, which object it was told about, and that a
// resend from the console is a new event for the same generation.

const { initializeApp, getApps } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { onObjectFinalized } = require('firebase-functions/v2/storage')

exports.storageFinalized = onObjectFinalized(async (event) => {
  if (!getApps().length) initializeApp()
  await getFirestore()
    .doc(`storageEvents/${event.id}`)
    .set({
      name: event.data.name,
      bucket: event.data.bucket,
      generation: String(event.data.generation),
    })
})
