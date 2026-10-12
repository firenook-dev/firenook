// The greeter extension's functions, written with the real SDK (1st gen, as
// published extensions are). `greet` answers with the configured greeting
// and announces it on the instance's Eventarc channel through the Admin
// SDK, exactly as an extension publishes its events.
//
// The Admin SDK's Eventarc client asks for a Google access token before it
// calls even the local emulator, and the emulator keeps the developer's own
// credentials away from functions, so its synthetic credential cannot mint
// one. This extension brings a token of its own; the Eventarc emulator does
// not check it.

const functions = require('firebase-functions/v1')
const { initializeApp } = require('firebase-admin/app')
const { getEventarc } = require('firebase-admin/eventarc')

initializeApp({
  credential: {
    getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }),
  },
})

/** The visitor's name from the query (`?name=Ada`) or a JSON body (`{"name":"Ada"}`). */
function nameOf(request) {
  const fromQuery = typeof request.query.name === 'string' ? request.query.name : undefined
  const fromBody =
    request.body && typeof request.body.name === 'string' ? request.body.name : undefined
  return (fromQuery ?? fromBody ?? 'friend').trim() || 'friend'
}

exports.greet = functions.https.onRequest(async (request, response) => {
  const name = nameOf(request)
  const greeting = (process.env.GREETING_TEMPLATE ?? 'Hello, {name}!').replaceAll('{name}', name)
  console.log(`greeting ${name}`)
  if (process.env.EVENTARC_CHANNEL) {
    const channel = getEventarc().channel(process.env.EVENTARC_CHANNEL, {
      allowedEventTypes: process.env.ALLOWED_EVENT_TYPES,
    })
    await channel.publish({
      type: 'test.greeter.v1.greeted',
      subject: `greetings/${name}`,
      data: { name, greeting, mode: process.env.MODE ?? 'fast' },
    })
  }
  response.json({ greeting })
})

exports.onProfile = functions.firestore.document('profiles/{id}').onWrite((change, context) => {
  console.log(`profile ${context.params.id} ${change.after.exists ? 'written' : 'deleted'}`)
})

exports.backfill = functions.tasks.taskQueue().onDispatch((data) => {
  console.log(`backfilling ${JSON.stringify(data)}`)
})
