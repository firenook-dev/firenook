// The compute stream's functions for its journeys (Functions, Extensions,
// Eventarc), written with the real SDK so every journey exercises the
// SDK's own decoding and error mapping rather than a hand-made handler's.
// FIXTURE_STREAMS=compute (or unset) loads them; index.js throws if an
// export name is already taken by another file. The compute stream owns
// this file; the blocking functions and the account trigger its journeys
// use live in auth.js (its profile loads both), and its Eventarc
// subscribers in compute-eventarc.js. Everything here is made up for the
// tests.

const functionsV1 = require('firebase-functions/v1')
const logger = require('firebase-functions/logger')
const { defineInt, defineSecret } = require('firebase-functions/params')
const { onNewFatalIssuePublished } = require('firebase-functions/v2/alerts/crashlytics')
const { onValueWritten } = require('firebase-functions/v2/database')
const { onDocumentWritten } = require('firebase-functions/v2/firestore')
const { HttpsError, onCall, onRequest } = require('firebase-functions/v2/https')
const { onMessagePublished } = require('firebase-functions/v2/pubsub')
const { onConfigUpdated } = require('firebase-functions/v2/remoteConfig')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const { onObjectFinalized } = require('firebase-functions/v2/storage')
const { onTaskDispatched } = require('firebase-functions/v2/tasks')

// Module scope runs on every load, so the codebase's load log has a line of
// its own to show.
console.log('compute fixture loaded')

/** The `uid` of the bearer token a request carries (the emulator's tokens are unsigned). */
function bearerUid(request) {
  const token = (request.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return claims.user_id ?? claims.sub ?? null
  } catch {
    return null
  }
}

const apiKey = defineSecret('API_KEY')
const missingKey = defineSecret('MISSING_KEY')
const batch = defineInt('BATCH', { default: 50 })

module.exports = {
  // An HTTP function that says what it was asked: method, path, query,
  // headers and the caller's uid. `/stream` answers in three chunks 400 ms
  // apart, `/fail` answers 500, `/exit` answers and then ends its worker.
  api: onRequest(async (request, response) => {
    console.log('hello from api')
    if (request.path === '/fail') {
      console.error('the order service refused the call')
      response.status(500).send('order service unavailable')
      return
    }
    if (request.path === '/stream') {
      response.setHeader('content-type', 'text/plain')
      for (const part of ['one\n', 'two\n', 'three\n']) {
        response.write(part)
        await new Promise((done) => setTimeout(done, 400))
      }
      response.end()
      return
    }
    if (request.path === '/exit') {
      response.json({ exiting: true })
      response.on('finish', () => setTimeout(() => process.exit(1), 50))
      return
    }
    response.json({
      method: request.method,
      path: request.path,
      query: request.query,
      headers: request.headers,
      uid: bearerUid(request),
      body: request.body ?? null,
    })
  }),

  // A callable that answers with what it was given and who called it;
  // `{ "fail": true }` fails the way the SDK maps an HttpsError, and a
  // caller that accepts streaming gets two chunks first.
  addMessage: onCall(async (request, response) => {
    if (request.data?.fail) throw new HttpsError('invalid-argument', 'text is required')
    if (request.acceptsStreaming) {
      await response.sendChunk({ part: 1 })
      await response.sendChunk({ part: 2 })
    }
    return {
      data: request.data ?? null,
      uid: request.auth?.uid ?? null,
      admin: request.auth?.token?.admin ?? null,
      appCheck: Boolean(request.app),
    }
  }),

  // A 1st-gen Firestore trigger, and a 2nd-gen one on the same path.
  onOrderCreated: functionsV1.firestore
    .document('orders/{orderId}')
    .onCreate((_snapshot, context) => {
      console.log(`order created ${context.params.orderId} (${process.env.GREETING})`)
    }),
  onOrderWritten: onDocumentWritten('orders/{orderId}', (event) => {
    logger.info('order written', { orderId: event.params.orderId })
  }),

  onUpload: onObjectFinalized((event) => {
    console.log(`uploaded ${event.data.name}`)
  }),
  onEmail: onMessagePublished('emails', (event) => {
    console.log(`email to ${event.data.message.json?.to ?? 'nobody'}`)
  }),

  nightly: onSchedule('every 5 minutes', () => {
    console.log('nightly ran')
  }),
  cleanup: onSchedule({ schedule: '0 3 * * *', timeZone: 'America/New_York' }, () => {
    console.log('cleanup ran')
  }),

  resize: onTaskDispatched({ retryConfig: { maxAttempts: 3 } }, (request) => {
    console.log(`resize ${JSON.stringify(request.data)}`)
  }),

  // Declared secrets, one in `.secret.local` and one missing, and a
  // declared param with a default.
  usesSecret: onRequest({ secrets: [apiKey, missingKey] }, (_request, response) => {
    response.json({ hasKey: Boolean(process.env.API_KEY) })
  }),
  batchJob: onRequest((_request, response) => {
    response.json({ batch: batch.value() })
  }),

  // Triggers the engine does not deliver: the Realtime Database is not
  // emulated, Firebase Alerts are not sent, and Remote Config is not a
  // trigger the emulator loads.
  legacyDb: onValueWritten('/legacy/{id}', () => {}),
  onCrash: onNewFatalIssuePublished(() => {}),
  onConfig: onConfigUpdated(() => {}),

  // Eventarc subscribers for the greeter extension's events.
  ...require('./compute-eventarc.js'),
}
