import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Badge } from '@/api/generated/live/Badge'
import {
  type LocalBadge,
  SEEN_KEY,
  markSeen,
  summarizeBadges,
  unseenCount,
  useLocalBadge,
  useLocalBadges,
  useSeen,
} from './badges'
import { useBadges } from './live/shell'

const rulesBroken: Badge = {
  id: 'firestore.rules',
  count: 1,
  kind: 'gauge',
  tone: 'danger',
  noun: { one: 'rules file does not compile', other: 'rules files do not compile' },
}

function inbox(count: number, cursor?: string): Badge {
  return {
    id: 'auth.inbox',
    count,
    kind: 'counter',
    tone: 'neutral',
    noun: { one: 'new code or link', other: 'new codes and links' },
    ...(cursor ? { cursor } : {}),
  }
}

const engine = (...badges: Badge[]) => new Map(badges.map((badge) => [badge.id, badge]))
const NO_LOCAL = new Map<string, LocalBadge>()

beforeEach(() => {
  localStorage.clear()
  useSeen.setState({ seen: {} })
  useBadges.setState({ badges: new Map() })
  useLocalBadges.setState({ badges: new Map() })
})

afterEach(() => localStorage.clear())

describe('what a badge shows', () => {
  it('a gauge, its count', () => {
    expect(unseenCount(rulesBroken, undefined, 'i1')).toBe(1)
  })

  it('a counter, what grew since this run’s seen record, never negative', () => {
    expect(unseenCount(inbox(5), { instance: 'i1', count: 3 }, 'i1')).toBe(2)
    expect(unseenCount(inbox(2), { instance: 'i1', count: 3 }, 'i1')).toBe(0)
  })

  it('every count of a run nobody has seen yet, a restart included', () => {
    expect(unseenCount(inbox(5), undefined, 'i1')).toBe(5)
    // The old run's seen value says nothing about the new run's count.
    expect(unseenCount(inbox(2), { instance: 'old', count: 40 }, 'i2')).toBe(2)
  })
})

describe('what the nav shows for an item', () => {
  it('nothing while every badge is at zero', () => {
    expect(
      summarizeBadges({
        ids: ['auth.inbox'],
        engine: engine(inbox(3)),
        local: NO_LOCAL,
        seen: { 'auth.inbox': { instance: 'i1', count: 3 } },
        instance: 'i1',
      }),
    ).toBeUndefined()
  })

  it('the loudest tone present and only that tone’s sum, every badge in the sentence', () => {
    const view = summarizeBadges({
      ids: ['firestore.rules', 'auth.inbox'],
      engine: engine(rulesBroken, inbox(3)),
      local: NO_LOCAL,
      seen: undefined,
      instance: 'i1',
    })
    expect(view).toMatchObject({ count: 1, tone: 'danger', counter: true })
    expect(view?.label).toBe(
      '1 rules file does not compile; 3 new codes and links since you last opened Authentication',
    )
  })

  it('merges the tab’s own badges with the engine’s', () => {
    const local = new Map<string, LocalBadge>([
      [
        'storage.uploads',
        { count: 2, tone: 'neutral', noun: { one: 'uploading', other: 'uploading' } },
      ],
    ])
    const view = summarizeBadges({
      ids: ['storage.uploads'],
      engine: new Map(),
      local,
      seen: undefined,
      instance: 'i1',
    })
    expect(view).toMatchObject({ count: 2, tone: 'neutral', label: '2 uploading', counter: false })
  })

  it('hands badgeLink the first counter’s seen record of this run', () => {
    const view = summarizeBadges({
      ids: ['auth.inbox'],
      engine: engine(inbox(9, 'c9')),
      local: NO_LOCAL,
      seen: { 'auth.inbox': { instance: 'i1', count: 4, cursor: 'c4' } },
      instance: 'i1',
    })
    expect(view?.seen).toEqual({ count: 4, cursor: 'c4' })
    expect(view?.count).toBe(5)
  })
})

describe('marking badges seen', () => {
  it('records counters with their cursor for this project and run, not gauges', () => {
    useBadges.setState({ badges: engine(rulesBroken, inbox(7, 'c7')) })
    markSeen('demo-x', 'i1', ['firestore.rules', 'auth.inbox'])
    const stored = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
    expect(stored).toEqual({
      'demo-x': { 'auth.inbox': { instance: 'i1', count: 7, cursor: 'c7' } },
    })
    expect(useSeen.getState().seen['demo-x']?.['auth.inbox']?.count).toBe(7)
  })

  it('keeps each project’s record apart', () => {
    useBadges.setState({ badges: engine(inbox(2)) })
    markSeen('demo-x', 'i1', ['auth.inbox'])
    markSeen('demo-y', 'i1', ['auth.inbox'])
    expect(Object.keys(useSeen.getState().seen)).toEqual(['demo-x', 'demo-y'])
  })

  it('reaches another tab through the storage event', () => {
    const record = { 'demo-x': { 'auth.inbox': { instance: 'i1', count: 3 } } }
    localStorage.setItem(SEEN_KEY, JSON.stringify(record))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SEEN_KEY }))
    })
    expect(useSeen.getState().seen).toEqual(record)
  })

  it('reads an unreadable record as nothing seen', () => {
    localStorage.setItem(SEEN_KEY, '{oops')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SEEN_KEY }))
    })
    expect(useSeen.getState().seen).toEqual({})
  })
})

describe('a tab’s own badge', () => {
  it('lives while its component is mounted and follows its count', () => {
    const noun = { one: 'uploading', other: 'uploading' }
    const { rerender, unmount } = renderHook(
      ({ count }: { count: number | undefined }) =>
        useLocalBadge(
          'storage.uploads',
          count === undefined ? undefined : { count, tone: 'neutral', noun },
        ),
      { initialProps: { count: 1 as number | undefined } },
    )
    expect(useLocalBadges.getState().badges.get('storage.uploads')?.count).toBe(1)
    rerender({ count: 3 })
    expect(useLocalBadges.getState().badges.get('storage.uploads')?.count).toBe(3)
    rerender({ count: undefined })
    expect(useLocalBadges.getState().badges.has('storage.uploads')).toBe(false)
    rerender({ count: 2 })
    unmount()
    expect(useLocalBadges.getState().badges.has('storage.uploads')).toBe(false)
  })
})
