// The compute stream's functions for its journeys. FIXTURE_STREAMS=compute (or unset)
// loads them; index.js throws if an export name is already taken by another
// file. The compute stream owns this file; the blocking functions and the
// account trigger it needs live in auth.js (its profile loads both).

module.exports = {
  // Eventarc subscribers for the greeter extension's events.
  ...require('./compute-eventarc.js'),
}
