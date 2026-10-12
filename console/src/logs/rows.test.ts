import { describe, expect, it } from 'vitest'
import type { LogEntry } from '@/api/generated/observe/LogEntry'
import { cursorParts, groupLines, isAfter, lineItem, sameLine } from './rows'

let seq = 0
function line(over: Partial<LogEntry> = {}): LogEntry {
  seq += 1
  return {
    cursor: `e1.${seq}`,
    time: '2026-10-12T04:06:09.117Z',
    level: 'info',
    service: 'functions',
    message: 'heartbeat ok',
    ...over,
  }
}

describe('rows', () => {
  it('group consecutive identical lines under the first one’s key', () => {
    const lines = [line(), line(), line(), line({ message: 'other' })]
    const { replaced, rows } = groupLines(lines)
    expect(replaced).toBeUndefined()
    expect(rows).toHaveLength(2)
    const [group, other] = rows
    expect(group).toMatchObject({ kind: 'line', key: lines[0]?.cursor, repeat: 3 })
    expect(group?.kind === 'line' && group.last.cursor).toBe(lines[2]?.cursor)
    expect(other).toMatchObject({ repeat: 1 })
  })

  it('break a group on another invocation, level, message or payload', () => {
    const base = line({ execution: 'a3f9c1-1' })
    expect(sameLine(base, { ...line(), execution: 'a3f9c1-2' })).toBe(false)
    expect(sameLine(base, { ...line(), execution: 'a3f9c1-1', level: 'warn' })).toBe(false)
    expect(sameLine(base, { ...line(), execution: 'a3f9c1-1', message: 'x' })).toBe(false)
    expect(sameLine(base, { ...line(), execution: 'a3f9c1-1', payload: { a: 1 } })).toBe(false)
    expect(sameLine(base, { ...line(), execution: 'a3f9c1-1' })).toBe(true)
    expect(sameLine({ ...base, payload: { a: 1 } }, { ...base, payload: { a: 1 } })).toBe(true)
  })

  it('grow the feed’s newest row when the lines repeat it, and never group a marker line', () => {
    const first = line()
    const previous = lineItem(first)
    const { replaced, rows } = groupLines([line(), line({ message: 'next' })], previous)
    expect(replaced).toMatchObject({ key: first.cursor, repeat: 2 })
    expect(rows).toHaveLength(1)
    const reload = line({ kind: 'functions.reloaded', message: 'Functions reloaded' })
    expect(sameLine(reload, { ...reload, cursor: 'e1.999' })).toBe(false)
  })

  it('never forms a group across a row that is not a line', () => {
    const { replaced } = groupLines([line()], { kind: 'edge', key: 'edge:start', edge: 'start' })
    expect(replaced).toBeUndefined()
  })

  it('reads cursors and orders them within one engine run', () => {
    expect(cursorParts('9f3c0a71.18204')).toEqual({ epoch: '9f3c0a71', seq: 18204 })
    expect(cursorParts('nope')).toBeUndefined()
    expect(isAfter('9f3c0a71.12', '9f3c0a71.11')).toBe(true)
    expect(isAfter('9f3c0a71.11', '9f3c0a71.11')).toBe(false)
    // A mark from another run is before every line of this one.
    expect(isAfter('9f3c0a71.1', '00000001.500')).toBe(true)
  })
})
