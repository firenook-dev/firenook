// The observe stream's functions for its journeys. FIXTURE_STREAMS=observe (or unset)
// loads them; index.js throws if an export name is already taken by another
// file. The observe stream owns this file.

const { onRequest } = require('firebase-functions/v2/https')
const { onDocumentDeleted } = require('firebase-functions/v2/firestore')
const { logger } = require('firebase-functions')

exports.hello = onRequest((req, res) => {
  console.log(`loading cart for ${req.query.uid ?? 'u_9f3k2'}`)
  logger.warn('Cart is empty', { cartId: 'c_19', items: [] })
  res.json({ ok: true })
})
exports.burst = onRequest((req, res) => {
  const n = Number(req.query.n ?? 1000)
  for (let i = 0; i < n; i += 1) console.log(`burst line ${i} of ${n}`)
  res.json({ n })
})
exports.fails = onRequest(() => {
  throw new TypeError("cannot read 'id' of undefined")
})
exports.debugs = onRequest((req, res) => {
  console.debug('debug detail for the e2e')
  res.json({ ok: true })
})
exports.onCartDeleted = onDocumentDeleted('carts/{id}', (event) => {
  logger.info('cart deleted', { id: event.params.id })
})
// Never answers, so the engine stops waiting after its one-second timeout
// and logs the failure itself: an error line, two lines long, whatever the
// engine knows about the invocation that printed it.
exports.stalls = onRequest({ timeoutSeconds: 1 }, () => {})
