import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  REQUEST_BYTES,
  base64Bytes,
  dataBytes,
  dataProblem,
  editableData,
  limitNotes,
  messageBytes,
  previewText,
  requestProblem,
  toWireData,
  utf8Bytes,
} from './payload'

const draft = (overrides: Partial<Parameters<typeof messageBytes>[0]> = {}) => ({
  kind: 'json' as const,
  data: '{"n":1}',
  attributes: [] as { key: string; value: string }[],
  orderingKey: '',
  ...overrides,
})

describe('typed data on the wire (U-02)', () => {
  it('goes as the kind it was written in', () => {
    expect(toWireData('json', '{"a":1}')).toEqual({ json: '{"a":1}' })
    expect(toWireData('text', 'hello')).toEqual({ text: 'hello' })
    expect(toWireData('base64', 'aGVs\nbG8=')).toEqual({ base64: 'aGVsbG8=' })
    expect(toWireData('avro-json', '{"a":1}')).toEqual({ avroJson: '{"a":1}' })
  })

  it('is checked before it is sent', () => {
    expect(dataProblem('json', '{"a":')).toMatch(/^Not valid JSON/)
    expect(dataProblem('json', '  ')).toBe('Write the JSON to send.')
    expect(dataProblem('json', '{"a":1}')).toBeUndefined()
    expect(dataProblem('base64', 'not base64!')).toBe('This is not base64.')
    expect(dataProblem('base64', 'aGVsbG8=')).toBeUndefined()
    expect(dataProblem('text', 'anything')).toBeUndefined()
  })
})

describe('sizes, as Pub/Sub counts them (U-02)', () => {
  it('counts UTF-8 bytes, and base64 by what it decodes to', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('日本')).toBe(6)
    expect(base64Bytes('aGVsbG8=')).toBe(5)
    expect(base64Bytes('aGVsbG8')).toBe(5)
    expect(base64Bytes('a')).toBeUndefined()
    expect(dataBytes('base64', 'aGVsbG8=')).toBe(5)
  })

  it('a message is its data, every attribute key and value, and its ordering key', () => {
    expect(
      messageBytes(
        draft({ data: '{"n":1}', attributes: [{ key: 'region', value: 'eu' }], orderingKey: 'k1' }),
      ),
    ).toBe(7 + 6 + 2 + 2)
  })
})

describe('production limits, warned not refused (U-02)', () => {
  it('a message over 10 MB', () => {
    const notes = limitNotes(draft({ kind: 'text', data: 'x'.repeat(LIMITS.messageBytes + 1) }))
    expect(notes).toEqual([
      {
        on: 'message',
        text: 'This message is 10,000,001 bytes; production refuses one over 10,000,000.',
      },
    ])
  })

  it('more than 100 attributes, a 257-byte key, a goog key, a long value, a long ordering key', () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ key: `k${index}`, value: 'v' }))
    expect(limitNotes(draft({ attributes: many })).map((note) => note.on)).toEqual(['attributes'])
    expect(limitNotes(draft({ attributes: [{ key: 'k'.repeat(257), value: 'v' }] }))).toEqual([
      { on: 'key', index: 0, text: 'The key is 257 bytes; production refuses one over 256.' },
    ])
    expect(limitNotes(draft({ attributes: [{ key: 'goog-trace', value: '1' }] }))).toEqual([
      { on: 'key', index: 0, text: 'Production refuses a key that starts with goog.' },
    ])
    expect(limitNotes(draft({ attributes: [{ key: 'k', value: 'v'.repeat(1025) }] }))[0]?.on).toBe(
      'value',
    )
    expect(limitNotes(draft({ orderingKey: 'k'.repeat(1025) }))).toEqual([
      {
        on: 'orderingKey',
        text: 'The ordering key is 1,025 bytes; production refuses one over 1,024.',
      },
    ])
    expect(limitNotes(draft())).toEqual([])
  })

  it('the console sends at most 64 MiB at once, repeats included', () => {
    expect(requestProblem(1024, 1000)).toBeUndefined()
    expect(requestProblem(REQUEST_BYTES)).toBeUndefined()
    expect(requestProblem(REQUEST_BYTES + 1)).toMatch(/at most 64 MiB at once/)
    expect(requestProblem(100_000, 1000)).toBe(
      '1,000 copies are 95.4 MB; the console sends at most 64 MiB at once. Publish fewer copies, or publish the data from a file.',
    )
  })
})

describe('what a list shows of a message (U-02)', () => {
  it('compact JSON or text as the engine cut it, binary as its size', () => {
    expect(previewText({ encoding: 'json', text: '{"a":1}', truncated: false }, 7)).toBe('{"a":1}')
    expect(previewText({ encoding: 'text', text: 'abc', truncated: true }, 900)).toBe('abc…')
    expect(previewText({ encoding: 'binary', text: 'AAEC', truncated: false }, 3277)).toBe(
      '⟨3.2 KB binary⟩',
    )
    expect(previewText({ encoding: 'text', text: '', truncated: false }, 0)).toBe('⟨empty⟩')
  })

  it('opens again in an editor as what it is', () => {
    expect(editableData('{"a":1}', 'eyJhIjoxfQ==', true)).toEqual({
      kind: 'json',
      data: '{\n  "a": 1\n}',
    })
    expect(editableData('plain', 'cGxhaW4=', false)).toEqual({ kind: 'text', data: 'plain' })
    expect(editableData(null, 'AAEC', false)).toEqual({ kind: 'base64', data: 'AAEC' })
  })
})
