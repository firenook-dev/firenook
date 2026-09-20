import { describe, expect, it } from 'vitest'
import {
  decodeDocument,
  decodeValue,
  displayValue,
  editorText,
  encodeValue,
  fromJson,
  parseEditorText,
  relativeTime,
  toJson,
} from './value'

const ROOT = 'projects/demo/databases/(default)/documents'

describe('the Firestore value codec', () => {
  it('decodes every REST value type and encodes it back unchanged', () => {
    const wire = {
      s: { stringValue: 'hi' },
      i: { integerValue: '42' },
      d: { doubleValue: 1.5 },
      b: { booleanValue: true },
      t: { timestampValue: '2026-09-20T09:00:00Z' },
      r: { referenceValue: `${ROOT}/users/u1` },
      g: { geoPointValue: { latitude: 3.1, longitude: 101.6 } },
      m: { mapValue: { fields: { inner: { nullValue: null } } } },
      a: { arrayValue: { values: [{ integerValue: '1' }, { stringValue: 'x' }] } },
      by: { bytesValue: 'AAEC' },
      v: {
        mapValue: {
          fields: {
            __type__: { stringValue: '__vector__' },
            value: { arrayValue: { values: [{ doubleValue: 0.5 }, { doubleValue: 1 }] } },
          },
        },
      },
    }
    for (const [key, value] of Object.entries(wire)) {
      const decoded = decodeValue(value)
      expect(encodeValue(decoded, ROOT), key).toEqual(value)
    }
    expect(decodeValue(wire.r)).toEqual({
      type: 'reference',
      value: `${ROOT}/users/u1`,
      path: 'users/u1',
    })
    expect(decodeValue(wire.v)).toEqual({ type: 'vector', values: [0.5, 1] })
  })

  it('keeps integers and doubles apart', () => {
    expect(decodeValue({ integerValue: '7' })).toEqual({ type: 'number', value: 7, integer: true })
    expect(decodeValue({ doubleValue: 7 })).toEqual({ type: 'number', value: 7, integer: false })
    expect(encodeValue({ type: 'number', value: 7, integer: false }, ROOT)).toEqual({
      doubleValue: 7,
    })
  })

  it('decodes a document with its relative path and marks never-written ancestors as missing', () => {
    const document = decodeDocument({
      name: `${ROOT}/users/u1/orders/o1`,
      fields: { total: { doubleValue: 9.5 } },
      createTime: '2026-09-20T09:00:00Z',
      updateTime: '2026-09-20T09:00:00Z',
    })
    expect(document).toMatchObject({
      path: 'users/u1/orders/o1',
      id: 'o1',
      collection: 'users/u1/orders',
    })
    expect(document.missing).toBeUndefined()
    expect(decodeDocument({ name: `${ROOT}/teams/t_ghost` }).missing).toBe(true)
  })

  it('renders one-line cell text per type', () => {
    expect(
      displayValue({ type: 'map', fields: { a: { type: 'null' }, b: { type: 'null' } } }),
    ).toBe('{ 2 fields }')
    expect(displayValue({ type: 'array', items: [] })).toBe('[]')
    expect(displayValue({ type: 'number', value: 1234567, integer: true })).toBe('1,234,567')
    expect(displayValue({ type: 'bytes', base64: 'AAEC' })).toBe('3 bytes')
  })

  it('parses editor text by type and reports what is wrong', () => {
    expect(parseEditorText('number', ' 12 ')).toEqual({
      ok: true,
      value: { type: 'number', value: 12, integer: true },
    })
    expect(parseEditorText('number', 'twelve')).toEqual({ ok: false, error: 'Not a number' })
    expect(parseEditorText('boolean', 'yes').ok).toBe(false)
    expect(parseEditorText('timestamp', '2026-09-20T09:00:00Z')).toEqual({
      ok: true,
      value: { type: 'timestamp', value: '2026-09-20T09:00:00.000Z' },
    })
    expect(parseEditorText('reference', `${ROOT}/users/u1`)).toEqual({
      ok: true,
      value: { type: 'reference', value: 'users/u1', path: 'users/u1' },
    })
    expect(parseEditorText('reference', 'users').ok).toBe(false)
    expect(parseEditorText('geopoint', '3.1, 101.6')).toEqual({
      ok: true,
      value: { type: 'geopoint', latitude: 3.1, longitude: 101.6 },
    })
    expect(parseEditorText('map', '{"a": 1}')).toEqual({
      ok: true,
      value: { type: 'map', fields: { a: { type: 'number', value: 1, integer: true } } },
    })
    expect(parseEditorText('array', '{"a": 1}').ok).toBe(false)
  })

  it('round-trips editor text for compound values', () => {
    const value = fromJson({ a: [1, 'two', null, { deep: true }] })
    const parsed = parseEditorText('map', editorText(value))
    expect(parsed.ok && parsed.value).toEqual(value)
    expect(toJson(value)).toEqual({ a: [1, 'two', null, { deep: true }] })
  })

  it('describes relative time in the shortest honest form', () => {
    const now = Date.parse('2026-09-20T09:00:00Z')
    expect(relativeTime('2026-09-20T08:59:50Z', now)).toBe('just now')
    expect(relativeTime('2026-09-20T08:57:00Z', now)).toBe('3 min ago')
    expect(relativeTime('2026-09-20T06:00:00Z', now)).toBe('3 h ago')
    expect(relativeTime('2026-09-15T09:00:00Z', now)).toBe('5 d ago')
    expect(relativeTime('2026-09-20T10:00:00Z', now)).toBe('in 1 h')
    expect(relativeTime('not a date', now)).toBe('not a date')
  })
})
