// The messaging journeys' functions (Pub/Sub, schedules and Cloud Tasks),
// written with the real SDK so a journey exercises its own decoding
// (`event.data.message.json`, `req.data`) rather than a hand-made handler's.
// FIXTURE_STREAMS=messaging (or unset) loads them; index.js throws if another
// stream's file already exports one of these names. Everything here is made
// up for the tests. The messaging stream owns this file.

const { onRequest, HttpsError } = require('firebase-functions/v2/https')
const logger = require('firebase-functions/logger')
const { onMessagePublished } = require('firebase-functions/v2/pubsub')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const { onTaskDispatched } = require('firebase-functions/v2/tasks')

/** How many times each pushed message has reached `pushSink`, by message id. */
const pushes = new Map()

module.exports = {
  // Every message published to `orders`. `{"fail": true, "reason": "…"}`
  // makes it throw, so a journey sees a failed delivery with the handler's
  // own error.
  onOrderPlaced: onMessagePublished('orders', (event) => {
    const data = event.data.message.json ?? {}
    if (data.fail) throw new Error(`order rejected: ${data.reason ?? 'no reason given'}`)
    logger.info('order placed', { orderId: data.orderId })
  }),

  // The dead-letter topic of `orders-worker`: a message nacked five times
  // lands here, and this function runs for it.
  onOrderDeadLettered: onMessagePublished('orders-dead', (event) => {
    logger.info('dead letter', { attributes: event.data.message.attributes })
  }),

  nightlyCleanup: onSchedule('every 5 minutes', async () => {
    logger.info('cleaned')
  }),

  // A cron schedule in a declared zone that always fails, for the failed
  // run and the time-zone journeys.
  weeklyDigest: onSchedule({ schedule: '0 9 * * 1', timeZone: 'Europe/Paris' }, async () => {
    throw new Error('digest service unavailable')
  }),

  // `{"fail": true}` answers 500 "card declined" on every attempt, so the
  // task runs out of its retries (maxAttempts 3, which the emulator runs
  // four times); `{"sleepMs": n}` holds a dispatch slot that long.
  processOrder: onTaskDispatched(
    {
      retryConfig: { maxAttempts: 3, minBackoffSeconds: 1, maxBackoffSeconds: 4 },
      rateLimits: { maxConcurrentDispatches: 2, maxDispatchesPerSecond: 10 },
    },
    async (req) => {
      const data = req.data ?? {}
      if (data.sleepMs) await new Promise((done) => setTimeout(done, data.sleepMs))
      if (data.fail) throw new HttpsError('internal', 'card declined')
      logger.info('processed', { id: req.id, retryCount: req.retryCount, data })
    },
  ),

  // A queue with the emulator's defaults.
  sendEmail: onTaskDispatched({}, async () => {}),

  // Refused by the Tasks emulator, which allows no underscore in a queue id,
  // so the console lists it under "Not registered".
  badQueue_1: onTaskDispatched({}, async () => {}),

  // A push endpoint: a message whose `failTimes` attribute is n is refused
  // with a 500 on its first n deliveries, then accepted.
  pushSink: onRequest((req, res) => {
    const message = req.body?.message ?? {}
    const failTimes = Number(message.attributes?.failTimes ?? 0)
    const count = (pushes.get(message.messageId) ?? 0) + 1
    pushes.set(message.messageId, count)
    if (count <= failTimes) {
      res.status(500).send(`attempt ${count} refused`)
      return
    }
    res.status(200).send(`attempt ${count} accepted`)
  }),
}
