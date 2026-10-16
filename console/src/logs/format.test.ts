import { describe, expect, it } from 'vitest'
import type { LogEntry } from '@/api/generated/observe/LogEntry'
import { formatClock } from '@/lib/format'
import { copiedTime, entriesAsNdjson, entriesAsText, entryAsJson, entryAsText } from './format'

const AT = '2026-10-12T04:06:09.126Z'
const WARN: LogEntry = {
  cursor: 'e1.7',
  time: AT,
  level: 'warn',
  service: 'functions',
  source: 'functions[us-central1-hello]',
  function: 'us-central1-hello',
  message: 'Cart is empty',
  payload: { cartId: 'c_19' },
}
const STACK: LogEntry = {
  cursor: 'e1.8',
  time: AT,
  level: 'error',
  service: 'hub',
  message: "TypeError: cannot read 'id'\n    at handler (index.js:41:18)\nat next",
}

describe('lines as text', () => {
  it('reads like the engine’s text download, in UTC by default', () => {
    expect(entryAsText(WARN)).toBe(
      `${AT} WARN  functions[us-central1-hello] Cart is empty\n    {"cartId":"c_19"}`,
    )
    expect(entryAsText(STACK)).toBe(
      `${AT} ERROR hub TypeError: cannot read 'id'\n        at handler (index.js:41:18)\n    at next`,
    )
  })

  it('carries the console-wide clock, except "ago", which copies the instant', () => {
    expect(copiedTime(AT, 'time')).toBe(formatClock(AT, 'time'))
    expect(copiedTime(AT, 'utc')).toBe(AT)
    expect(copiedTime(AT, 'relative')).toBe(AT)
    expect(entryAsText(WARN, 'time').startsWith(`${formatClock(AT, 'time')} WARN `)).toBe(true)
    expect(entryAsText(WARN, 'relative').startsWith(AT)).toBe(true)
    expect(entriesAsText([WARN, STACK]).split('\n')).toHaveLength(5)
  })

  it('writes NDJSON one LogEntry a line, and JSON as the engine sent it', () => {
    const lines = entriesAsNdjson([WARN, STACK]).split('\n')
    expect(lines.map((text) => JSON.parse(text) as LogEntry)).toEqual([WARN, STACK])
    expect(JSON.parse(entryAsJson(WARN))).toEqual(WARN)
  })
})
