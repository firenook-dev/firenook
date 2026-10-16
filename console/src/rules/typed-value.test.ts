import { describe, expect, it } from 'vitest'
import { rulesPathText, rulesValueText } from './typed-value'

describe('a rules value as text', () => {
  it('writes scalars as a grid cell does', () => {
    expect(rulesValueText({ nullValue: null })).toBe('null')
    expect(rulesValueText({ boolValue: false })).toBe('false')
    expect(rulesValueText({ intValue: '7340032' })).toBe('7,340,032')
    expect(rulesValueText({ floatValue: 0.5 })).toBe('0.5')
    expect(rulesValueText({ stringValue: 'image/png' })).toBe('image/png')
    expect(rulesValueText({ timestampValue: '2026-10-12T00:00:00Z' })).toBe('2026-10-12T00:00:00Z')
    expect(rulesValueText({ bytesValue: 'AAAA' })).toBe('3 bytes')
    expect(rulesValueText({ latlngValue: { latitude: 1.5 } })).toBe('1.5, 0')
  })

  it('writes a path below documents, and a container by its size', () => {
    const path = {
      segments: ['databases', '(default)', 'documents', 'users', 'u1'].map((simple) => ({
        simple,
      })),
    }
    expect(rulesPathText(path)).toBe('users/u1')
    expect(rulesValueText({ pathValue: { segments: [{ simple: 'b' }, { simple: 'o' }] } })).toBe(
      'b/o',
    )
    expect(rulesValueText({ mapValue: { fields: {} } })).toBe('{}')
    expect(
      rulesValueText({
        mapValue: { fields: { a: { stringValue: 'x' }, gone: { undefined: {} } } },
      }),
    ).toBe('{ 1 field }')
    expect(rulesValueText({ listValue: { values: [{ intValue: 1 }, { intValue: 2 }] } })).toBe(
      '[ 2 items ]',
    )
  })

  it('has no text for the runtime’s undefined marker', () => {
    expect(rulesValueText({ undefined: {} })).toBeUndefined()
    expect(rulesValueText(undefined)).toBeUndefined()
    expect(rulesValueText({})).toBeUndefined()
  })
})
