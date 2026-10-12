import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { testStatus } from '@/test/status'
import { HOST_KEY, readHostChoice, resolveHost, useConnectHost, writeHostChoice } from './host'

afterEach(() => localStorage.removeItem(HOST_KEY))

const refusing = {
  getItem: () => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('denied')
  },
}

const offered = [{ host: '127.0.0.1' }, { host: '192.168.1.20' }, { host: '10.0.2.2' }]

describe('the connection host', () => {
  it('is kept per browser and read back', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    expect(readHostChoice(storage)).toBeUndefined()
    writeHostChoice(storage, { host: '10.0.2.2', custom: false })
    expect(readHostChoice(storage)).toEqual({ host: '10.0.2.2', custom: false })
    values.set(HOST_KEY, '{"host":7}')
    expect(readHostChoice(storage)).toBeUndefined()
    values.set(HOST_KEY, 'not json')
    expect(readHostChoice(storage)).toBeUndefined()
  })

  it('falls back to the default when storage throws', () => {
    expect(readHostChoice(refusing)).toBeUndefined()
    expect(() => writeHostChoice(refusing, { host: 'x', custom: true })).not.toThrow()
    expect(resolveHost(readHostChoice(refusing), offered, '127.0.0.1')).toEqual({
      host: '127.0.0.1',
      custom: false,
    })
  })

  it('keeps an offered host only while it is offered, and a typed one always', () => {
    expect(resolveHost({ host: '10.0.2.2', custom: false }, offered, '127.0.0.1').host).toBe(
      '10.0.2.2',
    )
    expect(resolveHost({ host: '172.16.0.9', custom: false }, offered, '127.0.0.1')).toEqual({
      host: '127.0.0.1',
      custom: false,
    })
    expect(resolveHost({ host: 'dev.box', custom: true }, offered, '127.0.0.1')).toEqual({
      host: 'dev.box',
      custom: true,
    })
  })

  it('offers the engine’s hosts and remembers a pick or a typed host', () => {
    const status = testStatus({
      services: [{ name: 'hub', host: '127.0.0.1', port: 4400, listening: true, pid: null }],
    })
    const { result } = renderHook(() => useConnectHost(status))
    expect(result.current.host).toBe('127.0.0.1')
    expect(result.current.options.map((option) => option.host)).toContain('10.0.2.2')
    act(() => result.current.choose('10.0.2.2'))
    expect(result.current).toMatchObject({ host: '10.0.2.2', custom: false })
    expect(readHostChoice(localStorage)).toEqual({ host: '10.0.2.2', custom: false })
    act(() => result.current.chooseCustom('  [::1]  '))
    expect(result.current).toMatchObject({ host: '::1', custom: true })
    act(() => result.current.chooseCustom('   '))
    expect(result.current.host).toBe('::1')
  })
})
