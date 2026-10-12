import { describe, expect, expectTypeOf, it } from 'vitest'
import type { OverviewState } from '@/api/generated/observe/OverviewState'
import { type TopicMap, resumeOf } from '@/lib/live/topics'
import type { LogEntries, LogsTopicParams } from './live'
import './live'

describe("observe's topics", () => {
  it('replay the log by cursor and share the overview as state', () => {
    expect(resumeOf('logs.entries')).toBe('replay')
    expect(resumeOf('overview')).toBe('compare')
  })

  it('are typed for useLiveTopic', () => {
    expectTypeOf<TopicMap['logs.entries']['params']>().toEqualTypeOf<LogsTopicParams>()
    expectTypeOf<TopicMap['logs.entries']['events']['entries']>().toEqualTypeOf<LogEntries>()
    expectTypeOf<TopicMap['overview']['events']['state']>().toEqualTypeOf<OverviewState>()
    expectTypeOf<TopicMap['overview']['params']>().toEqualTypeOf<Record<string, never>>()
  })
})
