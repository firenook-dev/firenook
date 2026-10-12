import { describe, expect, it, vi } from 'vitest'
import { tasksPaletteGroups } from './palette'
import { idParam, readSearch, writeSearch } from './search'
import { testQueue } from './test-data'

describe('the page’s parameters', () => {
  it('read a task id the router parsed as a number back as text', () => {
    expect(readSearch({ queue: 'processOrder', task: 12, prefill: 7, q: 404 })).toMatchObject({
      queue: 'processOrder',
      task: '12',
      prefill: '7',
      q: '404',
    })
    expect(readSearch({ task: '12' }).task).toBe('12')
    expect(readSearch({}).task).toBeUndefined()
  })

  it('write an id as the number it is, so the address reads ?task=12', () => {
    expect(idParam('12')).toBe(12)
    expect(idParam('0012')).toBe('0012')
    expect(idParam('12345678901234567890')).toBe('12345678901234567890')
    expect(idParam(undefined)).toBeUndefined()
    expect(writeSearch({ task: '9', view: 'history' })).toEqual({ task: 9, view: 'history' })
    expect(writeSearch({ task: undefined })).toEqual({ task: undefined })
    expect(writeSearch({ q: 'card' })).toEqual({ q: 'card' })
  })
})

describe('⌘K on the Cloud Tasks page', () => {
  const processOrder = testQueue('processOrder')
  const sendEmail = testQueue('sendEmail', { paused: true })
  const commands = {
    enqueue: vi.fn(),
    pause: vi.fn(),
    purge: vi.fn(),
    hold: vi.fn(),
    view: vi.fn(),
  }

  it('offers what acts on the queue in view, worded for its state', () => {
    const [group] = tasksPaletteGroups({
      queues: [],
      queue: sendEmail,
      commands,
      open: vi.fn(),
      query: '',
    })
    expect(group?.label).toBe('sendEmail')
    const titles = group?.items.map((item) => item.title)
    expect(titles).toContain('Resume sendEmail')
    expect(titles).toContain('Purge sendEmail…')
    expect(titles).toContain('Hold scheduled tasks in sendEmail')
    group?.items.find((item) => item.title === 'Resume sendEmail')?.run()
    expect(commands.pause).toHaveBeenCalledWith(false)
  })

  it('lists the other queues by the ref the engine’s search answers with, filtered by the text', () => {
    const open = vi.fn()
    const groups = tasksPaletteGroups({
      queues: [processOrder, sendEmail],
      queue: processOrder,
      commands: undefined,
      open,
      query: 'send',
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]?.items.map((item) => [item.title, item.ref])).toEqual([
      ['sendEmail', { kind: 'tasks.queue', key: 'demo-console|us-central1|sendEmail' }],
    ])
    groups[0]?.items[0]?.run()
    expect(open).toHaveBeenCalledWith(sendEmail)
  })
})
