// The auth stream's functions for its journeys. FIXTURE_STREAMS=auth (or unset)
// loads them; index.js throws if an export name is already taken by another
// file. The auth stream owns this file, and only this file holds the
// blocking functions (beforeCreate, beforeSignIn) and onUserCreated.

module.exports = {}
