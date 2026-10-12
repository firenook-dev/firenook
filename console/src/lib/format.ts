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

/** "0.5 lines/s", "12 lines/s", "1.2k lines/s", "3.4M events/s". */
export function formatRate(perSecond: number, noun: string): string {
  const value = Math.max(0, perSecond)
  return `${compactNumber(value)} ${noun}/s`
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (value >= 1000) return `${trim(value / 1000)}k`
  if (value < 10 && !Number.isInteger(value)) return value.toFixed(1).replace(/\.0$/, '')
  return String(Math.round(value))
}

/** One decimal below 100, none from there: 1.2k, 12.5k, 120k. */
function trim(value: number): string {
  return value < 100 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
}

/** Relative time in the shortest honest form; the exact time stays a hover away. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((now - then) / 1000)
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
 * An id cut in the middle for a narrow cell: the start says what kind of
 * id it is and the end tells two of them apart. Short ids stay whole.
 */
export function shortId(id: string, keep = 6): string {
  if (id.length <= keep * 2 + 1) return id
  return `${id.slice(0, keep)}…${id.slice(-keep)}`
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
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
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
