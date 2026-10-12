import { describe, expect, it } from 'vitest'
import { pathPrefixes, spanOfPath, valueSpans } from './json-path'

const TEXT =
  '{\n  "orderId": "o_1",\n  "amount": "42.5",\n  "items": [{"sku": 1}, {"sku": "x"}],\n  "odd key": true\n}'

describe('where a schema problem lands in the text', () => {
  it('finds every value by the engine’s path', () => {
    const spans = valueSpans(TEXT)
    const at = (path: string) => {
      const span = spans?.get(path)
      return span ? TEXT.slice(span.from, span.to) : undefined
    }
    expect(at('$.amount')).toBe('"42.5"')
    expect(at('$.items[1].sku')).toBe('"x"')
    expect(at('$["odd key"]')).toBe('true')
    expect(at('$')).toBe(TEXT)
  })

  it('splits a path into what it passes through', () => {
    expect(pathPrefixes('$.items[2]["a b"].c')).toEqual([
      '$',
      '$.items',
      '$.items[2]',
      '$.items[2]["a b"]',
      '$.items[2]["a b"].c',
    ])
  })

  it('lands a missing field on the object that should hold it', () => {
    const span = spanOfPath(TEXT, '$.items[0].price')
    expect(span && TEXT.slice(span.from, span.to)).toBe('{"sku": 1}')
  })

  it('has nothing to say about text that is not JSON', () => {
    expect(valueSpans('{"a": ')).toBeUndefined()
    expect(spanOfPath('nope', '$.a')).toBeUndefined()
  })
})
