import { describe, expect, it } from 'vitest'
import { feedFooterText } from '@/components/console/feed-footer'
import { unreadBoundary } from './inbox-page'

describe('the inbox', () => {
  it('marks as new the messages that came since this browser last looked', () => {
    // 4 messages arrived since the last look, the newest being #20: #17 to #20 are new.
    expect(unreadBoundary({ newest: 20, unseen: 4, project: 'demo-a', configured: 'demo-a' })).toBe(
      16,
    )
    expect(unreadBoundary({ newest: 20, unseen: 0, project: 'demo-a', configured: 'demo-a' })).toBe(
      20,
    )
    // The configured project shown without its name in the address.
    expect(unreadBoundary({ newest: 3, unseen: 9, project: 'demo-a', configured: undefined })).toBe(
      0,
    )
    // Another project: the badge counted the emulator's own messages.
    expect(unreadBoundary({ newest: 20, unseen: 4, project: 'demo-b', configured: 'demo-a' })).toBe(
      20,
    )
  })

  it('says what is loaded beside what the engine keeps', () => {
    expect(feedFooterText(86, 2_000, { one: 'message', other: 'messages' })).toBe(
      '86 loaded · the engine keeps the newest 2,000 messages',
    )
  })
})
