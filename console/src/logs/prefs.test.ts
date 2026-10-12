import { afterEach, describe, expect, it } from 'vitest'
import { SAVED_FILTERS, parseSaved, useLogsPrefs, withSaved } from './prefs'

afterEach(() => localStorage.clear())

describe('Logs preferences', () => {
  it('keeps twelve saved filters a project, newest first, replacing one of the same name', () => {
    let list = parseSaved(null)
    for (let index = 0; index < SAVED_FILTERS + 3; index += 1)
      list = withSaved(list, { name: `f${index}`, q: `q${index}` })
    expect(list).toHaveLength(SAVED_FILTERS)
    expect(list[0]?.name).toBe(`f${SAVED_FILTERS + 2}`)
    const replaced = withSaved(list, { name: 'f10', q: 'new' })
    expect(replaced).toHaveLength(SAVED_FILTERS)
    expect(replaced.find((item) => item.name === 'f10')?.q).toBe('new')
  })

  it('reads only what it wrote', () => {
    expect(parseSaved('not json')).toEqual([])
    expect(parseSaved('{"a":1}')).toEqual([])
    expect(parseSaved('[{"name":"a","q":"x","from":"-5m"},{"name":3}]')).toEqual([
      { name: 'a', q: 'x', from: '-5m' },
    ])
  })

  it('remembers wrap, keep-across-restarts and saved filters per browser', () => {
    useLogsPrefs.getState().setWrap(true)
    useLogsPrefs.getState().setKeepAcrossRestarts(true)
    useLogsPrefs.getState().save('demo-x', { name: 'errors', q: 'level:error' })
    expect(localStorage.getItem('firenook.console.logs.wrap')).toBe('true')
    expect(localStorage.getItem('firenook.console.logs.keep-across-restarts')).toBe('true')
    expect(parseSaved(localStorage.getItem('firenook.console.logs.saved.demo-x'))).toEqual([
      { name: 'errors', q: 'level:error' },
    ])
    useLogsPrefs.getState().forget('demo-x', 'errors')
    expect(localStorage.getItem('firenook.console.logs.saved.demo-x')).toBeNull()
    useLogsPrefs.getState().setWrap(false)
    expect(localStorage.getItem('firenook.console.logs.wrap')).toBeNull()
  })
})
