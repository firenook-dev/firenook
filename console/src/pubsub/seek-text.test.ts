// U-09: the replay explanation, for each way a subscription and its topic
// can be set up, and the result line.

import { describe, expect, it } from 'vitest'
import { seekResultText, seekSentence, seekTime } from './seek-text'

describe('seekSentence', () => {
  it('brings acknowledged messages back only when the subscription keeps them', () => {
    expect(seekSentence('time', { retainAcked: true, waiting: 3 })).toBe(
      'Messages published after this become deliverable again, acknowledged ones too, because this subscription keeps acknowledged messages. Older ones are acknowledged.',
    )
    expect(seekSentence('time', { retainAcked: false, waiting: 3 })).toBe(
      'Messages published after this that are not yet acknowledged become deliverable again; acknowledged ones do not come back, because this subscription does not keep them (Keep acknowledged messages, in Settings). Older ones are acknowledged.',
    )
  })

  it('says a topic retention does not replay', () => {
    const sentence = seekSentence('time', {
      retainAcked: false,
      waiting: 0,
      topicRetentionSeconds: 3600,
    })
    expect(sentence).toContain('the emulator does not replay from it')
    // With acknowledged messages kept, the topic's retention changes nothing.
    expect(
      seekSentence('time', { retainAcked: true, waiting: 0, topicRetentionSeconds: 3600 }),
    ).toBe(seekSentence('time', { retainAcked: true, waiting: 0 }))
  })

  it('names what a snapshot recorded', () => {
    const snapshot = { id: 'before-fix', unacked: 12, createdAt: '2026-10-12T10:01:00Z' }
    expect(seekSentence('snapshot', { retainAcked: false, waiting: 0, snapshot })).toBe(
      'The subscription goes back to the snapshot: the 12 messages it recorded as waiting and every message published after it become deliverable again; the rest is acknowledged.',
    )
    expect(
      seekSentence('snapshot', {
        retainAcked: false,
        waiting: 0,
        snapshot: { ...snapshot, unacked: 1 },
      }),
    ).toContain('the 1 message it recorded')
    expect(
      seekSentence('snapshot', {
        retainAcked: false,
        waiting: 0,
        snapshot: { ...snapshot, unacked: 0 },
      }),
    ).toContain('nothing it recorded as waiting')
    expect(seekSentence('snapshot', { retainAcked: false, waiting: 0 })).toBe(
      'Choose a snapshot of this subscription’s topic.',
    )
  })

  it('counts what a purge acknowledges', () => {
    expect(seekSentence('purge', { retainAcked: false, waiting: 1204 })).toBe(
      'The 1,204 messages waiting now are acknowledged; messages published from now on arrive as usual.',
    )
    expect(seekSentence('purge', { retainAcked: false, waiting: 1 })).toBe(
      'The 1 message waiting now is acknowledged; messages published from now on arrive as usual.',
    )
    expect(seekSentence('purge', { retainAcked: true, waiting: 0 })).toBe(
      'Nothing is waiting now; messages published from now on arrive as usual.',
    )
  })
})

describe('seekResultText', () => {
  it('says what is available and acknowledged after the seek', () => {
    expect(seekResultText(12, 1190)).toBe('12 messages available, 1,190 acknowledged')
    expect(seekResultText(1, 0)).toBe('1 message available, 0 acknowledged')
  })
})

describe('seekTime', () => {
  it('puts a time of day on a local date', () => {
    const at = seekTime(new Date(2026, 9, 12, 23, 59, 59, 500), '10:02:13')
    expect([at.getFullYear(), at.getMonth(), at.getDate()]).toEqual([2026, 9, 12])
    expect([at.getHours(), at.getMinutes(), at.getSeconds(), at.getMilliseconds()]).toEqual([
      10, 2, 13, 0,
    ])
    expect(seekTime(new Date(2026, 9, 12), '7:05').getMinutes()).toBe(5)
  })
})
