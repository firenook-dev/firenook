import { describe, expect, it } from 'vitest'
import { checkFilter } from '@/lib/filter'
import { LOG_FIELDS } from './fields'
import { fromLegacyQuery, legacyItems } from './legacy'

/** The rewrite, checked to be a filter ours reads. */
function rewritten(text: string): string | undefined {
  const q = fromLegacyQuery(text)
  if (q !== undefined) expect(checkFilter(q, { fields: LOG_FIELDS, regex: true }).ok, q).toBe(true)
  return q
}

describe('a Google Emulator UI query', () => {
  it('reads every official key', () => {
    expect(rewritten('level="error"')).toBe('level:error')
    expect(rewritten('level="WARNING"')).toBe('level:warn')
    expect(rewritten('metadata.emulator.name="functions"')).toBe('service:functions')
    expect(rewritten('metadata.emulator="Firestore"')).toBe('service:firestore')
    expect(rewritten('metadata.function.name="us-central1-hello"')).toBe(
      'function:us-central1-hello',
    )
    expect(rewritten('metadata.function="us-central1-hello"')).toBe('function:us-central1-hello')
    expect(rewritten('metadata.extension.instanceId="resize-images"')).toBe(
      'instance:resize-images',
    )
    expect(rewritten('user.orderId="o_1"')).toBe('payload.orderId:"o_1"')
    expect(rewritten('user["orderId"]="o_1"')).toBe('payload.orderId:"o_1"')
    expect(rewritten('user["cart"]["id"]="c_19"')).toBe('payload.cart.id:"c_19"')
    expect(rewritten('user.count=3')).toBe('payload.count:3')
    expect(rewritten('search="cart is empty"')).toBe('"cart is empty"')
    expect(rewritten('search="loading"')).toBe('loading')
  })

  it('keeps quoted values with spaces and escapes, and the words left over', () => {
    expect(rewritten('metadata.function.name="us-central1-hello" "Cart \\"empty\\"" retry')).toBe(
      'function:us-central1-hello "Cart \\"empty\\"" retry',
    )
    expect(rewritten('level="error" user["the key"]="x y"')).toBe('level:error "x y"')
    expect(legacyItems('a="b c" d')).toEqual([
      { key: 'a', value: 'b c', quoted: true, raw: 'a="b c"' },
      { raw: 'd' },
    ])
  })

  it('leaves a filter of ours, and anything without an official pair, alone', () => {
    expect(fromLegacyQuery('')).toBeUndefined()
    expect(
      fromLegacyQuery('level:error function:us-central1-hello -"heartbeat ok"'),
    ).toBeUndefined()
    expect(fromLegacyQuery('/key=value/i burst')).toBeUndefined()
    expect(fromLegacyQuery('service=functions')).toBeUndefined()
    expect(fromLegacyQuery('"level=error"')).toBeUndefined()
  })

  it('rewrites only its own pairs and keeps the rest exactly as typed', () => {
    expect(rewritten('level="error" payload.orderId:"o_1" -burst')).toBe(
      'level:error payload.orderId:"o_1" -burst',
    )
  })
})
