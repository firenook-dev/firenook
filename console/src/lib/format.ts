// How the console writes numbers, sizes, durations and times: one place, so
// "1.2 s" on the Functions page and "1.2 s" in a Firestore footer are the
// same words for the same thing. Firestore's own helpers (`value.ts`,
// `size.ts`) re-export these rather than keeping copies.

import { create } from 'zustand'

/**
 * One formatter for every grouped integer: `toLocaleString('en-US')` builds
 * a new one per call (about 20 µs each), which a tree of shut rows or a
 * table's counts pay once a row.
 */
const GROUPED = new Intl.NumberFormat('en-US')

/** A count as the console writes it: grouped integers, fractions as typed. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return GROUPED.format(value)
  return String(value)
}

/** "1 user", "2,340 users". */
export function formatCount(count: number, noun: { one: string; other: string }): string {
  return `${formatNumber(count)} ${count === 1 ? noun.one : noun.other}`
}

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/**
 * Short enough for a footer, and precise where precision starts to
 * matter: tenths of a kilobyte while a document is small enough that they
 * are the difference, hundredths of a megabyte under 10 MB, where Firestore's
 * one-megabyte limit is and 1.0 against 1.04 is a write against a
 * rejection. Past that the figure is read for its size, not its digits.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const name = UNITS[unit]
  if (unit === 0) return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${name}`
  if (unit === 1 && value < 10) return `${value.toFixed(2)} ${name}`
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${name}`
}

/** "850 ms", "1.2 s", "42 s", "3 min 4 s", "2 h 5 min", "3 d 4 h". */
export function formatDuration(ms: number): string {
  const value = Math.max(0, ms)
  if (Math.round(value) < 1000) {
    if (value < 10 && !Number.isInteger(value)) return `${value.toFixed(1)} ms`
    return `${Math.round(value)} ms`
  }
  const seconds = value / 1000
  if (seconds < 10 && Math.round(seconds * 10) < 100) return `${seconds.toFixed(1)} s`
  if (Math.round(seconds) < 60) return `${Math.round(seconds)} s`
  const total = Math.round(seconds)
  if (total < 3600) {
    const minutes = Math.floor(total / 60)
    const rest = total % 60
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
  }
  const totalMinutes = Math.round(total / 60)
  if (totalMinutes < 24 * 60) {
    const hours = Math.floor(totalMinutes / 60)
    const rest = totalMinutes % 60
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
  }
  const totalHours = Math.round(totalMinutes / 60)
  const days = Math.floor(totalHours / 24)
  const rest = totalHours % 24
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`
}

/** Relative time in the shortest honest form; the exact time stays a hover away. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((now - then) / 1000)
  // A clock held to the minute (`useNow('minute')`) is up to 59 s behind,
  // so a time from the current minute can read as the future: it is now.
  if (seconds < 0 && seconds > -60) return 'just now'
  const future = seconds < 0
  const abs = Math.abs(seconds)
  const text =
    abs < 45
      ? 'just now'
      : abs < 90
        ? '1 min'
        : abs < 3600
          ? `${Math.round(abs / 60)} min`
          : abs < 86_400
            ? `${Math.round(abs / 3600)} h`
            : abs < 86_400 * 30
              ? `${Math.round(abs / 86_400)} d`
              : abs < 86_400 * 365
                ? `${Math.round(abs / (86_400 * 30))} mo`
                : `${Math.round(abs / (86_400 * 365))} y`
  if (text === 'just now') return text
  return future ? `in ${text}` : `${text} ago`
}

/**
 * A timestamp with the machinery taken out: no `T`, no sub-second, no
 * `Z`. What is left is the part a reader checks — the day and the time
 * — in the order the rest of the console writes them.
 */
export function compactIso(iso: string): string {
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z')
    .replace(/Z$/, '')
}

/**
 * An instant in UTC that says so: `2026-10-12 20:10:20 UTC`. `compactIso`
 * drops the zone, which is right beside a local clock that already says
 * "local", and wrong on its own: on a UTC+8 machine a bare
 * `2026-10-12 20:10:20` reads as eight in the evening here.
 */
export function utcStamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${compactIso(date.toISOString())} UTC`
}

/**
 * When something happened, as every inspector says it: the local clock
 * with its day, the instant as the engine wrote it, and how long ago —
 * `Today 04:10:27.670 local · 2026-10-12T20:10:27.670Z · 13 min ago`.
 */
export function whenParts(
  iso: string,
  now = Date.now(),
): { local: string; instant: string; ago: string } | undefined {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return undefined
  const today = new Date(now).toDateString() === date.toDateString()
  const day = today ? 'Today' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return {
    local: `${day} ${formatClock(iso, 'time', now)}`,
    instant: date.toISOString(),
    ago: relativeTime(iso, now),
  }
}

/** `whenParts` as one line. */
export function whenText(iso: string, now = Date.now()): string {
  const parts = whenParts(iso, now)
  return parts ? `${parts.local} local · ${parts.instant} · ${parts.ago}` : iso
}

/**
 * How every feed's time column reads, chosen once for the whole console:
 * the local time to the millisecond (`14:02:11.348`), how long ago
 * (`3 s ago`), or the UTC instant.
 */
export type ClockFormat = 'time' | 'relative' | 'utc'

const CLOCK_KEY = 'firenook.console.clock-format'

function readClock(): ClockFormat {
  try {
    const stored = localStorage.getItem(CLOCK_KEY)
    return stored === 'relative' || stored === 'utc' ? stored : 'time'
  } catch {
    return 'time'
  }
}

const useClockStore = create<{ format: ClockFormat; setFormat: (format: ClockFormat) => void }>(
  (set) => ({
    format: readClock(),
    setFormat: (format) => {
      try {
        localStorage.setItem(CLOCK_KEY, format)
      } catch {
        // A browser that refuses storage keeps the choice for this tab.
      }
      set({ format })
    },
  }),
)

// Another tab changing the format changes it here too.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === CLOCK_KEY) useClockStore.setState({ format: readClock() })
  })

/** The console-wide clock format, remembered per browser. */
export function useClockFormat(): {
  format: ClockFormat
  setFormat: (format: ClockFormat) => void
} {
  const format = useClockStore((state) => state.format)
  const setFormat = useClockStore((state) => state.setFormat)
  return { format, setFormat }
}

/** A feed's time cell in the chosen format; text that is not a time comes back as it was. */
export function formatClock(iso: string, format: ClockFormat, now = Date.now()): string {
  const date = new Date(iso)
  const then = date.getTime()
  if (Number.isNaN(then)) return iso
  if (format === 'utc') return date.toISOString()
  if (format === 'relative') return clockAgo(now - then)
  return clockTime(date)
}

/** A number to a fixed width with leading zeros: `7` → `07`; width 3 for milliseconds. */
export function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** How much of a time of day a clock shows: `14:02`, `14:02:11` or `14:02:11.348`. */
export type ClockPrecision = 'minute' | 'second' | 'ms'

/**
 * A time of day in local time, the console's one wall clock: `14:02:11.348`,
 * or to the `second` (`14:02:11`, a planned retry) or the `minute`
 * (`14:02`, a histogram bucket). `formatClock` draws its `time` form with
 * it. Text that is not a time comes back as it was.
 */
export function clockTime(at: string | number | Date, precision: ClockPrecision = 'ms'): string {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) return String(at)
  const minute = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (precision === 'minute') return minute
  const second = `${minute}:${pad(date.getSeconds())}`
  return precision === 'second' ? second : `${second}.${pad(date.getMilliseconds(), 3)}`
}

/** `14:02:11` today, `2026-10-12 14:02:11` on another day; local time. */
export function clockOrDate(iso: string, now = Date.now()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const time = clockTime(date, 'second')
  if (date.toDateString() === new Date(now).toDateString()) return time
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

/** Seconds count in a feed, where "just now" would hide the order of events. */
function clockAgo(ms: number): string {
  const future = ms < 0
  const seconds = Math.floor(Math.abs(ms) / 1000)
  const text =
    seconds < 60
      ? `${seconds} s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} min`
        : seconds < 86_400
          ? `${Math.floor(seconds / 3600)} h`
          : `${Math.floor(seconds / 86_400)} d`
  return future ? `in ${text}` : `${text} ago`
}
