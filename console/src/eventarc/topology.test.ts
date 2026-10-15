import { describe, expect, it } from 'vitest'
import type { EventarcChannel } from '@/api/generated/compute/EventarcChannel'
import {
  channelLabel,
  channelNamed,
  channelWarnings,
  editDistance,
  knownTypes,
  nearMisses,
  subscriberName,
} from './topology'

const NAME = 'projects/demo-x/locations/us-central1/channels/firebase'

function channel(overrides: Partial<EventarcChannel> = {}): EventarcChannel {
  return {
    name: NAME,
    location: 'us-central1',
    id: 'firebase',
    publishers: [
      {
        instanceId: 'greeter',
        instance: { kind: 'extensions.instance', key: 'greeter' },
        source: 'projects/demo-x/instances/greeter',
        allowed: ['test.greeter.v1.greeted'],
        declared: [
          { type: 'test.greeter.v1.greeted', description: null, allowed: true },
          { type: 'test.greeter.v1.failed', description: null, allowed: false },
        ],
      },
    ],
    subscriptions: [
      {
        triggerKey: `us-central1-onGreeted-0-${NAME}`,
        functionId: 'us-central1-onGreeted',
        function: { kind: 'functions.function', key: 'us-central1-onGreeted' },
        eventType: 'test.greeter.v1.greeted',
        filters: {},
        origin: 'definition',
        status: 'receiving',
      },
    ],
    events: 3,
    lastEventAt: null,
    ...overrides,
  }
}

const kinds = (list: { kind: string }[]) => list.map((warning) => warning.kind)

describe('what does not line up on a channel', () => {
  it('a declared type the instance may not publish', () => {
    const warnings = channelWarnings(channel(), [channel()])
    expect(warnings).toEqual([
      {
        kind: 'not-allowed',
        subject: 'test.greeter.v1.failed',
        text: 'test.greeter.v1.failed is declared by greeter but not allowed, so it is never published.',
        publisher: { kind: 'extensions.instance', key: 'greeter' },
      },
    ])
  })

  it('an allowed type the instance does not declare, with the instance to look at', () => {
    const typo = channel({
      publishers: [{ ...channel().publishers[0]!, allowed: ['test.greeter.v1.greted'] }],
    })
    const warnings = channelWarnings(typo, [typo])
    // The typo also leaves the real type unpublished for its listener.
    expect(kinds(warnings)).toEqual([
      'not-allowed',
      'undeclared-type',
      'unheard-type',
      'unpublished-type',
    ])
    expect(warnings[1]).toEqual({
      kind: 'undeclared-type',
      subject: 'test.greeter.v1.greted',
      text: 'greeter is allowed to publish test.greeter.v1.greted, which it does not declare; check ALLOWED_EVENT_TYPES in its parameter file.',
      publisher: { kind: 'extensions.instance', key: 'greeter' },
    })
  })

  it('an allowed type nobody listens for, and a listened type nobody publishes', () => {
    const lonely = channel({
      subscriptions: [
        {
          ...channel().subscriptions[0]!,
          eventType: 'x.y.z',
          triggerKey: 'us-central1-onXyz-0',
          functionId: 'us-central1-onXyz',
        },
      ],
    })
    const warnings = channelWarnings(lonely, [lonely])
    expect(kinds(warnings)).toEqual(['not-allowed', 'unheard-type', 'unpublished-type'])
    expect(warnings[1]?.text).toBe(
      'greeter publishes test.greeter.v1.greeted here, but no function listens for it.',
    )
    expect(warnings[2]?.text).toBe(
      'x.y.z is listened for here, but no extension on this channel publishes it; only your own code or the console can.',
    )
  })

  it('the same channel id in another location', () => {
    const elsewhere = channel({
      name: 'projects/demo-x/locations/europe-west1/channels/firebase',
      location: 'europe-west1',
    })
    const warnings = channelWarnings(channel(), [channel(), elsewhere])
    expect(warnings.at(-1)).toMatchObject({
      kind: 'other-location',
      text: 'A channel named firebase is also in europe-west1; publishers and handlers meet only in the same location.',
    })
  })

  it('a filter on an attribute that is not a CloudEvent’s own; never on subject', () => {
    const filtered = channel({
      subscriptions: [
        { ...channel().subscriptions[0]!, filters: { subject: 'greetings/vip-1', tier: 'gold' } },
      ],
    })
    const warnings = channelWarnings(filtered, [filtered])
    expect(kinds(warnings)).toEqual(['not-allowed', 'custom-attribute'])
    expect(warnings[1]?.text).toBe(
      'onGreeted filters on tier, an attribute only some publishers set; events without it never reach it.',
    )
  })

  it('the native channel has no location to compare', () => {
    const native = channel({ name: 'google', location: null, id: 'google', publishers: [] })
    expect(channelWarnings(native, [native, channel()])).toEqual([
      {
        kind: 'unpublished-type',
        subject: 'test.greeter.v1.greeted',
        text: 'test.greeter.v1.greeted is listened for here, but no extension on this channel publishes it; only your own code or the console can.',
      },
    ])
  })
})

describe('near misses for an unheard type', () => {
  it('names the types within three edits, nearest first, never the type itself', () => {
    const heard = [
      'test.greeter.v1.greeted',
      'test.greeter.v1.greeter',
      'other.type',
      'test.greeter.v1.greetd',
    ]
    expect(nearMisses('test.greeter.v1.greetd', heard)).toEqual([
      'test.greeter.v1.greeted',
      'test.greeter.v1.greeter',
    ])
    expect(nearMisses('completely.different', heard)).toEqual([])
  })

  it('counts edits, and stops counting past the limit', () => {
    expect(editDistance('greetd', 'greeted')).toBe(1)
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(editDistance('a', 'abcdefgh', 3)).toBe(4)
  })
})

describe('names', () => {
  it('a subscriber by its function’s short name, whatever its region', () => {
    expect(subscriberName(channel().subscriptions[0]!)).toBe('onGreeted')
    expect(
      subscriberName({ ...channel().subscriptions[0]!, functionId: 'asia-northeast1-onX' }),
    ).toBe('onX')
    expect(
      subscriberName({ ...channel().subscriptions[0]!, functionId: null, triggerKey: 'key-1' }),
    ).toBe('key-1')
  })

  it('a channel as the panel lists it, and found by its name', () => {
    expect(channelLabel(channel())).toEqual({ id: 'firebase', where: 'us-central1' })
    expect(channelLabel({ name: 'google', id: 'google', location: null })).toEqual({
      id: 'google',
      where: 'native',
    })
    const native = channel({ name: 'google', location: null, id: 'google' })
    expect(channelNamed([channel()], native, 'google')).toBe(native)
    expect(channelNamed([channel()], native, NAME)?.id).toBe('firebase')
    expect(channelNamed([channel()], native, 'nope')).toBeUndefined()
  })

  it('every type a snapshot knows, sorted', () => {
    expect(knownTypes([channel()])).toEqual(['test.greeter.v1.failed', 'test.greeter.v1.greeted'])
  })
})
