import { describe, expect, it } from 'vitest'
import {
  atSubscriptionText,
  backlogState,
  consumersText,
  countdownText,
  deliveryDetail,
  evictedText,
  functionMark,
  isStalled,
  subscriptionMark,
  subscriptionTone,
  waitedShort,
  waitedText,
} from './states'

const NOW = Date.parse('2026-10-12T10:00:00Z')
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString()

describe('subscription marks (U-10)', () => {
  it('draw each state in its own shape and say it in words', () => {
    expect(subscriptionMark('available')).toEqual({ shape: 'hollow', word: 'available' })
    expect(subscriptionMark('outstanding').shape).toBe('half')
    expect(subscriptionMark('pushing').shape).toBe('half')
    expect(subscriptionMark('acked').shape).toBe('filled')
    expect(subscriptionMark('drained')).toEqual({
      shape: 'filled',
      word: 'drained by the functions consumer',
    })
    expect(subscriptionMark('dead-lettered').shape).toBe('danger')
    expect(subscriptionMark('filtered')).toEqual({ shape: 'dashed', word: 'filtered out' })
    expect(subscriptionMark('not-tracked')).toEqual({
      shape: 'none',
      word: 'not tracked (created after this message)',
    })
  })

  it('spend colour only where it means something', () => {
    expect(subscriptionTone('available')).toBe('neutral')
    expect(subscriptionTone('outstanding')).toBe('brand')
    expect(subscriptionTone('pushing')).toBe('warning')
    expect(subscriptionTone('dead-lettered')).toBe('danger')
    expect(subscriptionTone('acked')).toBe('neutral')
  })
})

describe('function marks and deliveries (U-10)', () => {
  it('a glyph and a tone per outcome', () => {
    expect(functionMark('delivered')).toEqual({
      glyph: 'check',
      tone: 'success',
      word: 'delivered',
    })
    expect(functionMark('failed')).toEqual({ glyph: 'x', tone: 'danger', word: 'failed' })
    expect(functionMark('queued')).toEqual({ glyph: 'dots', tone: 'neutral', word: 'queued' })
    expect(functionMark('running').tone).toBe('brand')
    expect(functionMark('skipped').glyph).toBe('minus')
    expect(functionMark('not-kept')).toEqual({
      glyph: 'question',
      tone: 'neutral',
      word: 'no longer kept',
    })
  })

  const row = {
    mark: 'queued' as const,
    error: null,
    skippedReason: null,
    queueDepth: 214 as number | null,
    status: null,
  }
  it('say why a delivery is where it is', () => {
    expect(deliveryDetail(row)).toBe('214 deliveries waiting for a free slot')
    expect(deliveryDetail({ ...row, queueDepth: 1 })).toBe('1 delivery waiting for a free slot')
    expect(deliveryDetail({ ...row, queueDepth: null })).toBe('Waiting for a free slot')
    expect(deliveryDetail({ ...row, mark: 'skipped', queueDepth: null })).toBe(
      'Background triggers were paused, so the event was dropped, not queued.',
    )
    expect(deliveryDetail({ ...row, mark: 'not-kept' })).toBe(
      'The engine no longer keeps this invocation; it keeps the newest 2,000.',
    )
    expect(deliveryDetail({ ...row, mark: 'failed', error: 'order rejected: card declined' })).toBe(
      'order rejected: card declined',
    )
    expect(deliveryDetail({ ...row, mark: 'failed', status: 500 })).toBe(
      'The handler answered 500.',
    )
    expect(deliveryDetail({ ...row, mark: 'delivered' })).toBeUndefined()
  })
})

describe('time left and how long it waited (U-10)', () => {
  it('counts a lease down to the second', () => {
    expect(countdownText(at(6), NOW)).toBe('6 s left')
    expect(countdownText(at(64), NOW)).toBe('1 m 4 s left')
    expect(countdownText(at(120), NOW)).toBe('2 m left')
    expect(countdownText(at(0), NOW)).toBe('expired')
    expect(countdownText(at(-5), NOW)).toBe('expired')
    expect(countdownText(null, NOW)).toBe('')
  })

  it('says a backlog row’s state at this moment', () => {
    const base = { leaseExpiresAt: null, nextPushAt: null, attempts: 1 }
    expect(backlogState({ ...base, state: 'available' }, NOW)).toEqual({
      tone: 'neutral',
      word: 'available',
      redelivered: false,
    })
    expect(backlogState({ ...base, state: 'available', attempts: 3 }, NOW).redelivered).toBe(true)
    expect(backlogState({ ...base, state: 'outstanding', leaseExpiresAt: at(6) }, NOW)).toEqual({
      tone: 'brand',
      word: 'outstanding · 6 s left',
      redelivered: false,
    })
    expect(backlogState({ ...base, state: 'pushing', nextPushAt: at(1) }, NOW).word).toBe(
      'pushing · retry in 1 s',
    )
    expect(backlogState({ ...base, state: 'acked' }, NOW)).toEqual({
      tone: 'neutral',
      word: 'acked (retained)',
      redelivered: false,
    })
  })

  it('says how long the oldest message waited', () => {
    expect(waitedText(at(-4 * 60), NOW)).toBe('4 minutes')
    expect(waitedText(at(-1), NOW)).toBe('1 second')
    expect(waitedText(at(-3600), NOW)).toBe('1 hour')
    expect(waitedText(at(-3 * 86_400), NOW)).toBe('3 days')
    expect(waitedShort(at(-12), NOW)).toBe('12 s')
    expect(waitedShort(at(-4 * 60 - 30), NOW)).toBe('4 m')
    expect(waitedShort(at(-3 * 3600), NOW)).toBe('3 h')
    expect(waitedShort(at(-3 * 86_400), NOW)).toBe('3 d')
    expect(waitedShort(null, NOW)).toBe('')
  })

  it('calls a backlog stalled past three ack deadlines with nobody connected', () => {
    const idle = { streaming: 0, waitingPulls: 0 }
    expect(isStalled({ backlog: 5, oldestUnackedAt: at(-31), consumers: idle }, NOW)).toBe(true)
    expect(isStalled({ backlog: 5, oldestUnackedAt: at(-29), consumers: idle }, NOW)).toBe(false)
    expect(isStalled({ backlog: 5, oldestUnackedAt: at(-31), consumers: idle }, NOW, 60)).toBe(
      false,
    )
    expect(
      isStalled(
        { backlog: 5, oldestUnackedAt: at(-600), consumers: { streaming: 1, waitingPulls: 0 } },
        NOW,
      ),
    ).toBe(false)
    expect(isStalled({ backlog: 0, oldestUnackedAt: null, consumers: idle }, NOW)).toBe(false)
  })

  it('names who is consuming', () => {
    expect(consumersText({ streaming: 1, waitingPulls: 0 })).toBe('1 stream')
    expect(consumersText({ streaming: 0, waitingPulls: 2 })).toBe('2 waiting pulls')
    expect(consumersText({ streaming: 2, waitingPulls: 1 })).toBe('2 streams · 1 waiting pull')
    expect(consumersText({ streaming: 0, waitingPulls: 0 })).toBe('—')
  })
})

describe('a message at one subscription, in the inspector (U-10)', () => {
  const base = {
    subscription: 'projects/p/subscriptions/s',
    attempts: 0,
    leaseExpiresAt: null,
    nextPushAt: null,
    filteredBy: null,
  }
  it('says what became of it there', () => {
    expect(atSubscriptionText({ ...base, state: 'available' }, NOW)).toBe(
      'available, not yet delivered',
    )
    expect(
      atSubscriptionText(
        { ...base, state: 'outstanding', attempts: 2, leaseExpiresAt: at(6) },
        NOW,
        5,
      ),
    ).toBe('outstanding, delivery 2 of 5, lease ends in 6 s')
    expect(
      atSubscriptionText({ ...base, state: 'filtered', filteredBy: 'attributes.kind = "a"' }, NOW),
    ).toBe('filtered out by attributes.kind = "a"')
    expect(atSubscriptionText({ ...base, state: 'dead-lettered' }, NOW, 5)).toBe(
      'dead-lettered after 5 deliveries',
    )
    expect(atSubscriptionText({ ...base, state: 'drained' }, NOW)).toBe(
      'drained by the functions consumer',
    )
    expect(atSubscriptionText({ ...base, state: 'not-tracked' }, NOW)).toBe(
      'not tracked: the subscription was created after this message',
    )
  })
})

describe('the evicted-history sentence (U-10)', () => {
  it('appears only once something was dropped', () => {
    const window = {
      messages: 5000,
      bytes: 1000,
      oldestId: '1',
      capacityMessages: 5000,
      capacityBytes: 16 * 1024 * 1024,
      dropped: 0,
    }
    expect(evictedText(window, 'orders')).toBeUndefined()
    expect(evictedText({ ...window, dropped: 214 }, 'orders')).toBe(
      'The engine no longer keeps older messages of orders; it keeps the newest 5,000 (16.0 MB).',
    )
  })
})
