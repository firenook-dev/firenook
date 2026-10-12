import { describe, expect, it } from 'vitest'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageObjectChange } from '@/api/generated/storage/StorageObjectChange'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { activityEntries, deliveryText } from './activity-tab'
import { resendSentence } from './event-payloads'
import { fieldSuggestions } from './metadata-tab'
import { mediaDuration } from './preview-media'
import { editBlocked } from './preview-text'

const change = (at: string, revision: number): StorageObjectChange => ({
  revision,
  at,
  bucket: 'b',
  name: 'a.png',
  kind: 'created',
  size: 1,
  contentType: 'image/png',
  metadataKeys: [],
  actor: { kind: 'admin', uid: null, tenant: null, viaConsole: true },
  delivery: 'sent',
})
const decision = (at: string, id: string): StorageDecision => ({
  id,
  at,
  bucket: 'b',
  method: 'get',
  path: 'a.png',
  outcome: 'deny',
  error: null,
  uid: 'u1',
  tenant: null,
  provider: null,
  anonymous: false,
  allows: [],
  rulesHash: 'h',
  noRuleset: false,
  size: null,
  contentType: null,
  viaConsole: false,
})

describe('the activity list', () => {
  it('merges changes and decisions newest first, each decision once', () => {
    const entries = activityEntries(
      [change('2026-10-12T09:00:00Z', 1), change('2026-10-12T09:02:00Z', 2)],
      [decision('2026-10-12T09:01:00Z', 's1'), decision('2026-10-12T09:01:00Z', 's1')],
    )
    expect(entries.map((entry) => entry.kind)).toEqual(['change', 'decision', 'change'])
  })

  it('says what became of an event only when there is something to say', () => {
    expect(deliveryText('sent')).toBe('Sent to the Functions emulator')
    expect(deliveryText('paused')).toBe('Background triggers are paused')
    expect(deliveryText('failed')).toMatch(/stopping/)
    expect(deliveryText('no-functions')).toBeUndefined()
    expect(deliveryText('no-event')).toBeUndefined()
  })

  it('says what a resend did', () => {
    expect(resendSentence('finalize', true)).toBe(
      'Sent the finalize event to the Functions emulator',
    )
    expect(resendSentence('metadataUpdate', false)).toMatch(/metadataUpdated event was not sent/)
  })
})

describe('the inspector', () => {
  const object = {
    name: 'docs/readme.md',
    size: 100,
    contentEncoding: null,
    sniffed: { mime: 'image/png', family: 'image', definite: true },
  } as unknown as StorageObjectDetail

  it('edits in place only a small text that is stored as it reads', () => {
    expect(editBlocked(object)).toBeUndefined()
    expect(editBlocked({ ...object, contentEncoding: 'gzip' })).toMatch(/gzip/)
    expect(editBlocked({ ...object, size: 2 * 1024 * 1024 })).toMatch(/1 MB/)
  })

  it('suggests the detected type first, and a disposition with the file’s name', () => {
    expect(fieldSuggestions('contentType', object).slice(0, 2)).toEqual([
      'image/png',
      'text/markdown',
    ])
    expect(fieldSuggestions('contentDisposition', object)).toContain(
      'attachment; filename="readme.md"',
    )
    expect(fieldSuggestions('contentLanguage', object)).toEqual([])
  })

  it('writes a media length as a player does', () => {
    expect(mediaDuration(42.2)).toBe('0:42')
    expect(mediaDuration(3725)).toBe('1:02:05')
    expect(mediaDuration(Number.NaN)).toBe('')
  })
})
