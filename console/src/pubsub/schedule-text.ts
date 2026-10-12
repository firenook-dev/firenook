// A schedule in words (SC-01, U-05): what an `onSchedule` expression means
// — App Engine's own English ("every 5 minutes", "every day 03:00") read
// back as a sentence, and a Unix cron line ("0 9 * * 1") turned into one
// ("every Monday at 09:00") — when it is next due, in the zone it is
// evaluated in and on this machine's clock, and what state it is in. An
// expression this cannot put into words is shown as it is, with nothing
// beside it: a wrong sentence is worse than none.

import type { PubsubSchedule } from '@/api/generated/messaging/PubsubSchedule'
import type { StatusTone } from '@/components/kit'
import { relativeTime } from '@/lib/format'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}
const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

/** "a, b and c". */
function joined(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`
}

const pad = (value: number) => String(value).padStart(2, '0')

// ------------------------------------------------------------ cron

/** One part of a field: a value, a range, or a stepped range (`*` is 0 to the field's top). */
interface Part {
  from: number
  to: number
  step: number
}

interface Field {
  /** `*` (or `?`). */
  any: boolean
  parts: Part[]
}

/** A cron field read, or undefined when it does not read. */
function readField(
  text: string,
  low: number,
  high: number,
  names: Record<string, number> = {},
): Field | undefined {
  if (text === '*' || text === '?') return { any: true, parts: [{ from: low, to: high, step: 1 }] }
  const parts: Part[] = []
  for (const item of text.split(',')) {
    const [range = '', stepText] = item.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return undefined
    const value = (word: string) => {
      const named = names[word.toLowerCase()]
      if (named !== undefined) return named
      const number = Number(word)
      return word !== '' && Number.isInteger(number) ? number : undefined
    }
    let from: number | undefined
    let to: number | undefined
    if (range === '*') {
      from = low
      to = high
    } else if (range.includes('-')) {
      const [start = '', end = ''] = range.split('-')
      from = value(start)
      to = value(end)
    } else {
      from = value(range)
      to = stepText === undefined ? from : high
    }
    if (from === undefined || to === undefined || from < low || to > high || from > to)
      return undefined
    parts.push({ from, to, step })
  }
  return { any: false, parts }
}

/** The single values a field holds, or undefined when it holds a range or a step. */
function singles(field: Field): number[] | undefined {
  if (field.any) return undefined
  const values: number[] = []
  for (const part of field.parts) {
    if (part.step !== 1 || part.from !== part.to) return undefined
    values.push(part.from)
  }
  return values
}

/** A field that is the whole range stepped (every fifth minute), as its step. */
function everyStep(field: Field, low: number, high: number): number | undefined {
  const part = field.parts[0]
  if (field.any || field.parts.length !== 1 || !part) return undefined
  return part.from === low && part.to === high && part.step > 1 ? part.step : undefined
}

type Time = { kind: 'at'; text: string } | { kind: 'every'; text: string }

function timePhrase(minute: Field, hour: Field): Time | undefined {
  const minutes = singles(minute)
  const hours = singles(hour)
  const minuteStep = everyStep(minute, 0, 59)
  const hourStep = everyStep(hour, 0, 23)
  if (minutes && hours) {
    const times = hours.flatMap((h) => minutes.map((m) => h * 60 + m)).toSorted((a, b) => a - b)
    if (times.length > 6) return undefined
    return {
      kind: 'at',
      text: `at ${joined(times.map((time) => `${pad(Math.floor(time / 60))}:${pad(time % 60)}`))}`,
    }
  }
  if (minutes?.length === 1) {
    const at = minutes[0] ?? 0
    const onTheHour = at === 0 ? ', on the hour' : ` at :${pad(at)}`
    if (hour.any) return { kind: 'every', text: `every hour${onTheHour}` }
    if (hourStep) return { kind: 'every', text: `every ${hourStep} hours${onTheHour}` }
    const range = hour.parts[0]
    if (hour.parts.length === 1 && range && range.step === 1)
      return {
        kind: 'every',
        text: `every hour from ${pad(range.from)}:${pad(at)} to ${pad(range.to)}:${pad(at)}`,
      }
    return undefined
  }
  if (minute.any && hour.any) return { kind: 'every', text: 'every minute' }
  if (minuteStep) {
    if (hour.any) return { kind: 'every', text: `every ${minuteStep} minutes` }
    const range = hour.parts[0]
    if (hour.parts.length === 1 && range && range.step === 1)
      return {
        kind: 'every',
        text: `every ${minuteStep} minutes from ${pad(range.from)}:00 to ${pad(range.to)}:59`,
      }
  }
  if (minute.any && hours?.length === 1)
    return {
      kind: 'every',
      text: `every minute from ${pad(hours[0] ?? 0)}:00 to ${pad(hours[0] ?? 0)}:59`,
    }
  return undefined
}

/** Weekdays in words: one, a list, or a run ("Monday to Friday"). */
function weekdaysPhrase(field: Field): string | undefined {
  const parts = field.parts.map((part) => ({ ...part, from: part.from % 7, to: part.to % 7 }))
  if (parts.some((part) => part.step !== 1)) return undefined
  const words = parts.map((part) =>
    part.from === part.to
      ? (WEEKDAYS[part.from] ?? '')
      : `${WEEKDAYS[part.from] ?? ''} to ${WEEKDAYS[part.to] ?? ''}`,
  )
  return joined(words)
}

function dayPhrase(day: Field, month: Field, weekday: Field): string | undefined {
  const days = singles(day)
  const months = singles(month)
  if (!month.any && !months) return undefined
  const inMonths = months ? ` in ${joined(months.map((value) => MONTHS[value - 1] ?? ''))}` : ''
  if (day.any && weekday.any) return months ? `every day${inMonths}` : 'every day'
  const weekdays = weekday.any ? undefined : weekdaysPhrase(weekday)
  if (!weekday.any && weekdays === undefined) return undefined
  if (day.any) return `every ${weekdays ?? ''}${inMonths}`
  if (!days) return undefined
  const dates =
    months?.length === 1 && weekday.any
      ? `on ${MONTHS[(months[0] ?? 1) - 1] ?? ''} ${joined(days.map(String))}`
      : `on ${days.length === 1 ? 'day' : 'days'} ${joined(days.map(String))} of ${months ? `${joined(months.map((value) => MONTHS[value - 1] ?? ''))}` : 'every month'}`
  // Both restricted: cron runs on either (the engine keeps cron's rule).
  return weekday.any ? dates : `${dates} or every ${weekdays ?? ''}`
}

function describeCron(fields: readonly string[]): string | undefined {
  const [minuteText = '', hourText = '', dayText = '', monthText = '', weekdayText = ''] = fields
  const minute = readField(minuteText, 0, 59)
  const hour = readField(hourText, 0, 23)
  const day = readField(dayText, 1, 31)
  const month = readField(monthText, 1, 12, MONTH_NAMES)
  const weekday = readField(weekdayText, 0, 7, WEEKDAY_NAMES)
  if (!minute || !hour || !day || !month || !weekday) return undefined
  const time = timePhrase(minute, hour)
  const days = dayPhrase(day, month, weekday)
  if (!time || !days) return undefined
  if (time.kind === 'at') return `${days} ${time.text}`
  return days === 'every day' ? time.text : `${time.text}, ${days.replace(/^every /, 'on ')}`
}

// ------------------------------------------------------------ App Engine

/** A weekday as App Engine writes one ("monday", "mon"), named; undefined for any other word. */
function weekdayWord(word: string): string | undefined {
  const lower = word.toLowerCase()
  const full = WEEKDAYS.find((day) => day.toLowerCase() === lower)
  if (full) return full
  const short = lower.length === 3 ? WEEKDAY_NAMES[lower] : undefined
  return short === undefined ? undefined : WEEKDAYS[short]
}

/** App Engine's English, read back as a sentence: weekdays named, "at" before the time. */
function describeAppEngine(text: string): string {
  const words = text.split(/\s+/)
  return words
    .map((word, index) => {
      // "every day 03:00" → "every day at 03:00"; "from 10:00 to 14:00" keeps its words.
      if (/^\d{1,2}:\d{2}$/.test(word)) {
        const before = words[index - 1]?.toLowerCase()
        return before === 'from' || before === 'to' || before === 'at' ? word : `at ${word}`
      }
      if (word.toLowerCase() === 'synchronized') return 'on the clock'
      const days = word.split(',').map(weekdayWord)
      return days.every((day) => day !== undefined) ? joined(days as string[]) : word
    })
    .join(' ')
}

/**
 * What an expression means, in a sentence; undefined when it cannot be put
 * into words (the expression is then shown alone).
 */
export function describeSchedule(expression: string): string | undefined {
  const text = expression.trim()
  if (text === '') return undefined
  if (/^every\b/i.test(text) || /\bof\b/i.test(text) || /^\d+(st|nd|rd|th)\b/i.test(text))
    return describeAppEngine(text)
  const fields = text.split(/\s+/)
  return fields.length === 5 ? describeCron(fields) : undefined
}

// ------------------------------------------------------------ times and states

/** "in 42 s", "in 3 min", "in 7 d"; "due now" once it has passed. */
export function nextRunText(iso: string | null, now: number): string {
  if (!iso) return '—'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const seconds = Math.round((at - now) / 1000)
  if (seconds <= 0) return 'due now'
  if (seconds < 60) return `in ${seconds} s`
  return relativeTime(iso, now)
}

/** A time in a zone, "Mon 19 Oct, 09:00"; in UTC when the zone is not one this browser knows. */
export function zoneTime(iso: string, zone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone }).format(new Date(iso))
  } catch {
    return `${new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(new Date(iso))} UTC`
  }
}

/** The same time on this machine's clock. */
export function localTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

/** "Mon 19 Oct, 09:00 Europe/Paris · Mon 19 Oct, 15:00 here". */
export function nextRunExact(iso: string, zone: string): string {
  return `${zoneTime(iso, zone)} ${zone} · ${localTime(iso)} here`
}

export type ScheduleState = 'running' | 'paused' | 'not-automatic'

/** A schedule's state: not automatic outranks paused, since its clock never runs. */
export function scheduleState(
  schedule: Pick<PubsubSchedule, 'automatic' | 'paused'>,
): ScheduleState {
  if (!schedule.automatic) return 'not-automatic'
  return schedule.paused ? 'paused' : 'running'
}

export function stateLook(state: ScheduleState): { word: string; tone: StatusTone } {
  // Status words, capitalised as every status word is (Cloud Tasks' queues say the same).
  if (state === 'paused') return { word: 'Paused', tone: 'neutral' }
  if (state === 'not-automatic') return { word: 'Not automatic', tone: 'warning' }
  return { word: 'Running', tone: 'neutral' }
}

/** Why a schedule is not automatic, with the way it still runs. */
export function notAutomaticText(problem: string | null): string {
  return `${problem ?? 'The engine cannot evaluate this expression'} — run it here with Run now.`
}
