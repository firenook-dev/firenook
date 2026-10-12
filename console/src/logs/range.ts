// The time window of the Logs page: the URL's `from` and `to`, which the
// engine reads as RFC 3339 instants, relative times (`-5m`) or, for `from`,
// `reload` (since the last Functions reload). Every line the engine keeps
// when neither is set. Times are when each line was recorded.

/** The windows the range picker offers by name. */
export interface RangePreset {
  id: 'all' | '1m' | '5m' | '15m' | '1h' | 'reload'
  /** The menu item's title. */
  title: string
  /** What the trigger reads while it is the window. */
  short: string
  /** `from` as the URL writes it; none for every line. */
  from: string | undefined
}

export const RANGE_PRESETS: readonly RangePreset[] = [
  { id: 'all', title: 'All lines', short: 'All lines', from: undefined },
  { id: '1m', title: 'Last minute', short: 'Last minute', from: '-1m' },
  { id: '5m', title: 'Last 5 minutes', short: 'Last 5 min', from: '-5m' },
  { id: '15m', title: 'Last 15 minutes', short: 'Last 15 min', from: '-15m' },
  { id: '1h', title: 'Last hour', short: 'Last hour', from: '-1h' },
  { id: 'reload', title: 'Since the last Functions reload', short: 'Since reload', from: 'reload' },
]

/** The preset a window is, or undefined for a window of its own (custom, a bucket, around a line). */
export function presetOf(
  from: string | undefined,
  to: string | undefined,
): RangePreset | undefined {
  if (to !== undefined) return undefined
  const normal = from === '-60m' ? '-1h' : from
  return RANGE_PRESETS.find((preset) => preset.from === normal)
}

const pad = (value: number) => String(value).padStart(2, '0')

/** `12:05`, `12:05:10` when it has seconds, with the day in front when it is not today. */
export function clockText(ms: number, now = Date.now()): string {
  const date = new Date(ms)
  const time =
    date.getSeconds() === 0 && date.getMilliseconds() === 0
      ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
      : `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const today = new Date(now)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (sameDay) return time
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${day} ${time}`
}

/** A `from` or `to` the engine reads as an instant, in milliseconds; undefined for relative ones. */
function instant(text: string | undefined): number | undefined {
  if (text === undefined || text === 'reload' || text.startsWith('-')) return undefined
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? undefined : ms
}

/** What the range picker's trigger reads for a window. */
export function rangeLabel(
  from: string | undefined,
  to: string | undefined,
  now = Date.now(),
): string {
  const preset = presetOf(from, to)
  if (preset) return preset.short
  const start = instant(from)
  const end = instant(to)
  if (start !== undefined && end !== undefined)
    return `${clockText(start, now)}–${clockText(end, now)}`
  if (start !== undefined) return `From ${clockText(start, now)}`
  if (end !== undefined) return `Until ${clockText(end, now)}`
  // A relative window of the developer's own (`-30m`).
  if (from?.startsWith('-')) return `Last ${from.slice(1)}`
  return 'All lines'
}

/** The window of histogram buckets `low` to `high`, as instants. */
export function bucketWindow(
  histogram: { from: string; bucketMs: number },
  low: number,
  high: number,
): { from: string; to: string } {
  const start = Date.parse(histogram.from)
  return {
    from: new Date(start + low * histogram.bucketMs).toISOString(),
    to: new Date(start + (high + 1) * histogram.bucketMs).toISOString(),
  }
}

/** Thirty seconds either side of a line: "Around". */
export function aroundWindow(time: string, seconds = 30): { from: string; to: string } {
  const at = Date.parse(time)
  return {
    from: new Date(at - seconds * 1000).toISOString(),
    to: new Date(at + seconds * 1000).toISOString(),
  }
}

/** An instant as a `datetime-local` input writes it, in local time, to the second. */
export function toLocalInput(text: string | undefined): string {
  const ms = instant(text)
  if (ms === undefined) return ''
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** A `datetime-local` input's value as an instant; undefined when empty or not a time. */
export function fromLocalInput(value: string): string | undefined {
  if (value === '') return undefined
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}
