import { beforeEach, describe, expect, it } from 'vitest'
import { emptyDraft, fromRecent, readRecent, rememberDraft } from './composer-store'
import { outgoing, prefillSource, repeatCount, usesTemplates } from './components/composer'
import { fileSummary, readMessagesFile } from './components/publish-file'
import {
  jobEndText,
  jobProgressText,
  publishedText,
  skippedText,
} from './components/publish-result'

beforeEach(() => localStorage.clear())

const draft = (overrides: Partial<ReturnType<typeof emptyDraft>> = {}) => ({
  ...emptyDraft(),
  data: '{"n":1}',
  ...overrides,
})

describe('a draft on the wire', () => {
  it('sends its data as written, its enabled attributes, its ordering key', () => {
    expect(
      outgoing(
        draft({
          attributes: [
            { id: 'a', key: 'region', value: 'eu', enabled: true },
            { id: 'b', key: 'off', value: 'x', enabled: false },
            { id: 'c', key: '', value: '', enabled: true },
          ],
          orderingKey: 'cust-1',
        }),
      ),
    ).toEqual({ data: { json: '{"n":1}' }, attributes: { region: 'eu' }, orderingKey: 'cust-1' })
    expect(outgoing(draft({ kind: 'text', data: 'hi' }))).toEqual({ data: { text: 'hi' } })
  })

  it('knows a template when it sees one, in data or an attribute value', () => {
    expect(usesTemplates(draft({ data: '{"n":"{{i}}"}' }))).toBe(true)
    expect(usesTemplates(draft({ data: '{"at":"{{ now }}"}' }))).toBe(true)
    expect(
      usesTemplates(
        draft({ attributes: [{ id: 'a', key: 'id', value: '{{uuid}}', enabled: true }] }),
      ),
    ).toBe(true)
    expect(usesTemplates(draft({ data: '{"n":"{{nope}}"}' }))).toBe(false)
  })

  it('repeats 1 to 1,000 copies', () => {
    expect(repeatCount('1')).toBe(1)
    expect(repeatCount('1000')).toBe(1000)
    expect(repeatCount('1001')).toBeUndefined()
    expect(repeatCount('0')).toBeUndefined()
    expect(repeatCount('2.5')).toBeUndefined()
  })

  it('reads a prefill of this topic or of another', () => {
    expect(prefillSource('42', 'projects/p/topics/orders')).toEqual({
      topic: 'projects/p/topics/orders',
      id: '42',
    })
    expect(prefillSource('projects/p/topics/orders-dead|7', 'projects/p/topics/orders')).toEqual({
      topic: 'projects/p/topics/orders-dead',
      id: '7',
    })
  })
})

describe('recent drafts', () => {
  it('keeps the ten last published per topic, newest first, the same one once', () => {
    for (let index = 0; index < 12; index += 1)
      rememberDraft(
        'p',
        't',
        draft({ data: `{"n":${index}}` }),
        new Date(Date.UTC(2026, 0, 1, 0, index)),
      )
    rememberDraft('p', 't', draft({ data: '{"n":11}' }), new Date(Date.UTC(2026, 0, 1, 1)))
    const recent = readRecent('p', 't')
    expect(recent).toHaveLength(10)
    expect(recent.map((entry) => entry.data).slice(0, 2)).toEqual(['{"n":11}', '{"n":10}'])
    expect(readRecent('p', 'other')).toEqual([])
    expect(fromRecent(recent[0]!).data).toBe('{"n":11}')
  })
})

describe('publishing a file (PS-19)', () => {
  it('reads the NDJSON the export writes', () => {
    const file = [
      JSON.stringify({
        id: '1',
        publishTime: 'x',
        data: 'eyJuIjoxfQ==',
        attributes: { a: 'b' },
        orderingKey: 'k',
      }),
      '',
      JSON.stringify({
        id: '2',
        publishTime: 'x',
        data: 'aGk=',
        attributes: {},
        orderingKey: null,
      }),
    ].join('\n')
    const read = readMessagesFile(file)
    expect(read).toEqual({
      ok: true,
      bytes: 7 + 2 + 1 + 2,
      messages: [
        { data: { base64: 'eyJuIjoxfQ==' }, attributes: { a: 'b' }, orderingKey: 'k' },
        { data: { base64: 'aGk=' } },
      ],
    })
    expect(fileSummary(214, 'orders.ndjson')).toBe('214 messages from orders.ndjson')
  })

  it('says which line it cannot read', () => {
    expect(readMessagesFile('{"data":"aGk="}\nnope')).toEqual({
      ok: false,
      message: 'Line 2 is not JSON.',
    })
    expect(readMessagesFile('{"data":"!!"}')).toEqual({
      ok: false,
      message: 'Line 1: data is base64, as the export writes it.',
    })
    expect(readMessagesFile('   ')).toEqual({ ok: false, message: 'The file is empty.' })
  })
})

describe('what a publish says (S3)', () => {
  it('names the id and who it reached', () => {
    expect(
      publishedText({ messageIds: ['1188'], subscriptions: 2, functions: 1, functionsSkipped: 0 }),
    ).toBe('Published 1 · id 1188 → 2 subscriptions, 1 function')
    expect(
      skippedText({ messageIds: ['1'], subscriptions: 0, functions: 1, functionsSkipped: 1 }),
    ).toBe('1 function skipped — background triggers are paused')
  })

  it('a job’s progress and its end', () => {
    expect(jobProgressText({ done: 12, total: 20 }, 'every second')).toBe('12 of 20 · every second')
    expect(jobProgressText({ done: 12, total: 20 }, 'at once')).toBe('12 of 20 sent')
    expect(jobEndText({ state: 'done', done: 20, total: 20, errorCount: 0 }, 'orders')).toBe(
      'Published 20 messages to orders',
    )
    expect(jobEndText({ state: 'cancelled', done: 7, total: 20, errorCount: 0 }, 'orders')).toBe(
      'Stopped after 7 messages',
    )
  })
})
