// U-05: schedules in words — App Engine's English read back, Unix cron
// turned into sentences (values, lists, ranges, steps, names, weekdays),
// and nothing said where the words would be a guess; plus when the next
// run is, and the state a schedule is in.

import { describe, expect, it } from 'vitest'
import {
  describeSchedule,
  nextRunExact,
  nextRunText,
  notAutomaticText,
  scheduleState,
  stateLook,
  zoneTime,
} from './schedule-text'

describe('App Engine schedules', () => {
  it('read back as sentences', () => {
    expect(describeSchedule('every 5 minutes')).toBe('every 5 minutes')
    expect(describeSchedule('every day 03:00')).toBe('every day at 03:00')
    expect(describeSchedule('every monday 09:00')).toBe('every Monday at 09:00')
    expect(describeSchedule('every mon,wed 09:00')).toBe('every Monday and Wednesday at 09:00')
    expect(describeSchedule('every 2 hours from 10:00 to 14:00')).toBe(
      'every 2 hours from 10:00 to 14:00',
    )
    expect(describeSchedule('every 5 minutes synchronized')).toBe('every 5 minutes on the clock')
  })
})

describe('cron schedules', () => {
  it('say a single time on the days it runs', () => {
    expect(describeSchedule('0 9 * * 1')).toBe('every Monday at 09:00')
    expect(describeSchedule('30 3 * * *')).toBe('every day at 03:30')
    expect(describeSchedule('0 9 * * MON')).toBe('every Monday at 09:00')
    expect(describeSchedule('0 9 * * 7')).toBe('every Sunday at 09:00')
  })

  it('say lists and ranges of days and times', () => {
    expect(describeSchedule('0 9 * * 1-5')).toBe('every Monday to Friday at 09:00')
    expect(describeSchedule('0 9 * * 1,3,5')).toBe('every Monday, Wednesday and Friday at 09:00')
    expect(describeSchedule('30 8,12 * * *')).toBe('every day at 08:30 and 12:30')
    expect(describeSchedule('0 9 1 * *')).toBe('on day 1 of every month at 09:00')
    expect(describeSchedule('0 9 1,15 * *')).toBe('on days 1 and 15 of every month at 09:00')
    expect(describeSchedule('0 9 1 1 *')).toBe('on January 1 at 09:00')
    expect(describeSchedule('0 0 * JAN,JUL *')).toBe('every day in January and July at 00:00')
    expect(describeSchedule('0 9 1 * 1')).toBe('on day 1 of every month or every Monday at 09:00')
  })

  it('say steps as how often', () => {
    expect(describeSchedule('* * * * *')).toBe('every minute')
    expect(describeSchedule('*/5 * * * *')).toBe('every 5 minutes')
    expect(describeSchedule('0 * * * *')).toBe('every hour, on the hour')
    expect(describeSchedule('15 * * * *')).toBe('every hour at :15')
    expect(describeSchedule('0 */2 * * *')).toBe('every 2 hours, on the hour')
    expect(describeSchedule('0 9-17 * * *')).toBe('every hour from 09:00 to 17:00')
    expect(describeSchedule('*/10 9-17 * * 1-5')).toBe(
      'every 10 minutes from 09:00 to 17:59, on Monday to Friday',
    )
  })

  it('say nothing rather than guess', () => {
    expect(describeSchedule('0-30/10 1-4/2 * * *')).toBeUndefined()
    expect(describeSchedule('61 * * * *')).toBeUndefined()
    expect(describeSchedule('0 9 * *')).toBeUndefined()
    expect(describeSchedule('')).toBeUndefined()
    expect(describeSchedule('0,5,10,15,20,25,30 0 * * *')).toBeUndefined()
  })
})

describe('the next run and the state', () => {
  const now = Date.parse('2026-10-12T10:00:00Z')

  it('counts down the next run', () => {
    expect(nextRunText('2026-10-12T10:00:42Z', now)).toBe('in 42 s')
    expect(nextRunText('2026-10-12T10:03:00Z', now)).toBe('in 3 min')
    expect(nextRunText('2026-10-19T07:00:00Z', now)).toBe('in 7 d')
    expect(nextRunText('2026-10-12T09:59:00Z', now)).toBe('due now')
    expect(nextRunText(null, now)).toBe('—')
  })

  it('says the next run in its zone', () => {
    expect(zoneTime('2026-10-19T07:00:00Z', 'Europe/Paris')).toBe('Mon 19 Oct, 09:00')
    expect(zoneTime('2026-10-19T07:00:00Z', 'UTC')).toBe('Mon 19 Oct, 07:00')
    expect(zoneTime('2026-10-19T07:00:00Z', 'Nowhere/Else')).toBe('Mon 19 Oct, 07:00 UTC')
    expect(nextRunExact('2026-10-19T07:00:00Z', 'Europe/Paris')).toMatch(
      /^Mon 19 Oct, 09:00 Europe\/Paris · .+ here$/,
    )
  })

  it('names the state: not automatic before paused', () => {
    expect(scheduleState({ automatic: true, paused: false })).toBe('running')
    expect(scheduleState({ automatic: true, paused: true })).toBe('paused')
    expect(scheduleState({ automatic: false, paused: true })).toBe('not-automatic')
    expect(stateLook('not-automatic')).toEqual({ word: 'Not automatic', tone: 'warning' })
    expect(stateLook('paused')).toEqual({ word: 'Paused', tone: 'neutral' })
    expect(stateLook('running')).toEqual({ word: 'Running', tone: 'neutral' })
    expect(notAutomaticText('unsupported Firebase schedule expression: every monday 9')).toBe(
      'unsupported Firebase schedule expression: every monday 9 — run it here with Run now.',
    )
  })
})
