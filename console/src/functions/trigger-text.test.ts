import { describe, expect, it } from 'vitest'
import { summary, trigger } from './fixtures.test-support'
import {
  asSentence,
  changeWord,
  lastSegment,
  notLoadedText,
  sentenceParts,
  statusText,
  triggerSentence,
  triggerText,
} from './trigger-text'

const firestore = summary('onOrderCreated', 'firestore', {
  trigger: trigger({
    eventType: 'providers/cloud.firestore/eventTypes/document.create',
    database: '(default)',
    document: 'orders/{orderId}',
    matchType: 'pattern',
  }),
})

describe('a trigger in words', () => {
  it('reads the change word from either generation', () => {
    expect(changeWord('providers/cloud.firestore/eventTypes/document.create')).toBe('created')
    expect(changeWord('google.cloud.firestore.document.v1.written')).toBe('written')
    expect(changeWord('google.cloud.firestore.document.v1.updated.withAuthContext')).toBe('updated')
    expect(changeWord('google.storage.object.finalize')).toBe('finalized')
    expect(changeWord('google.cloud.storage.object.v1.metadataUpdated')).toBe('metadata updated')
    expect(changeWord(null)).toBeUndefined()
    expect(lastSegment('projects/p/topics/emails')).toBe('emails')
  })

  it('writes one line per kind for the overview', () => {
    expect(triggerText(summary('api'))).toBe('/demo-test/us-central1/api')
    expect(triggerText(firestore)).toBe('orders/{orderId} created · (default)')
    expect(
      triggerText(
        summary('onUpload', 'storage', {
          trigger: trigger({
            eventType: 'google.cloud.storage.object.v1.finalized',
            bucket: 'b.appspot.com',
          }),
        }),
      ),
    ).toBe('gs://b.appspot.com finalized')
    expect(
      triggerText(
        summary('onEmail', 'pubsub', { trigger: trigger({ topic: 'projects/p/topics/emails' }) }),
      ),
    ).toBe('topic emails')
    expect(
      triggerText(
        summary('cleanup', 'schedule', {
          trigger: trigger({ schedule: '0 3 * * *', timeZone: 'America/New_York' }),
        }),
      ),
    ).toBe('0 3 * * * · America/New_York')
    expect(
      triggerText(
        summary('onGreetedVip', 'eventarc', {
          trigger: trigger({
            eventType: 'test.greeter.v1.greeted',
            channel: 'projects/p/locations/us-central1/channels/firebase',
            filters: { subject: 'greetings/vip-1' },
          }),
        }),
      ),
    ).toBe('test.greeter.v1.greeted · firebase · subject=greetings/vip-1')
    expect(
      triggerText(
        summary('beforeCreate', 'blocking', {
          trigger: trigger({ blockingEvent: 'beforeCreate' }),
        }),
      ),
    ).toBe('beforeCreate (sign-up)')
    expect(
      triggerText(
        summary('onUserCreated', 'auth', {
          trigger: trigger({ eventType: 'providers/firebase.auth/eventTypes/user.create' }),
        }),
      ),
    ).toBe('user created')
    expect(triggerText(summary('resize', 'tasks'))).toBe('task queue')
  })

  it('writes a sentence with its code marked', () => {
    const sentence = triggerSentence(firestore)
    expect(sentence).toBe(
      'Runs when a document matching `orders/{orderId}` in `(default)` is created',
    )
    expect(sentenceParts(sentence)).toEqual([
      { text: 'Runs when a document matching ', code: false },
      { text: 'orders/{orderId}', code: true },
      { text: ' in ', code: false },
      { text: '(default)', code: true },
      { text: ' is created', code: false },
    ])
    const written = summary('onOrderWritten', 'firestore', {
      trigger: trigger({
        eventType: 'google.cloud.firestore.document.v1.written',
        document: 'orders/{orderId}',
      }),
    })
    expect(triggerSentence(written)).toContain('is created, updated or deleted')
  })

  it('says why a function receives nothing without the runtime repeating the word', () => {
    expect(
      statusText({
        status: 'ignored',
        statusReason:
          'function ignored because the database emulator does not exist or is not running.',
      }),
    ).toBe('Ignored: The database emulator does not exist or is not running.')
    expect(
      statusText({
        status: 'ignored',
        statusReason: 'Firebase Alerts are not delivered by this engine yet.',
      }),
    ).toBe('Ignored: Firebase Alerts are not delivered by this engine yet.')
    expect(
      statusText({ status: 'noService', statusReason: 'Storage is not running in this suite' }),
    ).toBe('No service: Storage is not running in this suite.')
    expect(statusText({ status: 'receiving', statusReason: null })).toBe('Receiving')
    expect(
      notLoadedText({
        id: 'us-central1-onConfig',
        eventType: 'google.firebase.remoteconfig.remoteConfig.v1.updated',
        reason: 'google.firebase.remoteconfig.remoteConfig.v1.updated is not emulated',
      }),
    ).toBe('Not loaded: google.firebase.remoteconfig.remoteConfig.v1.updated is not emulated.')
    expect(asSentence('done!')).toBe('Done!')
  })
})
