// A schedule's state as the `pubsub.schedules` frames patch it into the
// list the Functions overview and Schedule tab read: what a frame names
// changes at once, the rest keeps its identity, and a frame that names
// nothing leaves the page as it was.

import { describe, expect, it } from 'vitest'
import type { Page } from '@/api/generated/Page'
import type { PubsubSchedule } from '@/api/generated/messaging/PubsubSchedule'
import { applySchedulesFrame, schedulesKey } from './schedules'

/** A schedule with only what a frame patches. */
const schedule = (functionId: string, runs: number) =>
  ({
    functionId,
    paused: false,
    automatic: true,
    nextRunAt: null,
    runs,
  }) as unknown as PubsubSchedule

describe('the schedules list, live', () => {
  it('patches the states a frame names', () => {
    const page: Page<PubsubSchedule> = {
      items: [schedule('a', 1), schedule('b', 1)],
      nextCursor: null,
      prevCursor: null,
      total: { count: 2, exact: true },
      scanned: null,
    }
    const patched = applySchedulesFrame(page, {
      revision: 4,
      schedules: [
        {
          functionId: 'a',
          paused: true,
          automatic: true,
          nextRunAt: 'later',
          runs: 2,
          lastRunAt: null,
          lastOutcome: 'delivered',
        },
      ],
    })
    expect(patched.items[0]).toMatchObject({ paused: true, runs: 2, nextRunAt: 'later' })
    expect(patched.items[1]).toBe(page.items[1])
    expect(applySchedulesFrame(page, { revision: 5, schedules: [] })).toBe(page)
  })

  it('lives under Pub/Sub’s keys, so a reset of Pub/Sub reads it again', () => {
    expect(schedulesKey('demo')).toEqual(['pubsub', 'demo', 'schedules'])
  })
})
