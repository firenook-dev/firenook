const { onCall, HttpsError } = require('firebase-functions/v2/https');
exports.echo = onCall((req) => ({ echoed: req.data, uid: req.auth ? req.auth.uid : null }));
exports.fails = onCall(() => { throw new HttpsError('permission-denied', 'nope', { why: 'test' }); });
