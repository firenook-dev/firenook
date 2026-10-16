// What the shell journeys (`e2e/shell.spec.ts`) need of the codebase. The
// `all` profile names this file in FIXTURE_STREAMS; no stream's profile
// loads it, so no section's function counts include it.

const { onDocumentWritten } = require('firebase-functions/v2/firestore')

module.exports = {
  // A function a document written under `shellWatched` reaches: while a
  // harness pauses background triggers, such a write is a change "that
  // reached no function", which the paused banner counts.
  shellWatched: onDocumentWritten('shellWatched/{id}', () => undefined),
}
