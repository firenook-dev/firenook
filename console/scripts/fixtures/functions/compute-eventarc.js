// The compute stream's Eventarc subscribers: two handlers for the greeter
// extension's `test.greeter.v1.greeted` on the default channel, the second
// filtered to one subject, so an event can reach one and miss the other.
// `compute.js` loads this file; it is not a stream file of its own.

const { onCustomEventPublished } = require('firebase-functions/v2/eventarc')

const CHANNEL = 'locations/us-central1/channels/firebase'

module.exports = {
  onGreeted: onCustomEventPublished(
    { eventType: 'test.greeter.v1.greeted', channel: CHANNEL },
    (event) => {
      console.log(`greeted ${event.subject ?? '(no subject)'}`)
    },
  ),
  onGreetedVip: onCustomEventPublished(
    {
      eventType: 'test.greeter.v1.greeted',
      channel: CHANNEL,
      filters: { subject: 'greetings/vip-1' },
    },
    (event) => {
      console.log(`a VIP was greeted: ${event.subject}`)
    },
  ),
}
