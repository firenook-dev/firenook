import { describe, expect, it } from 'vitest'
import {
  CLAIMS_LIMIT,
  FORBIDDEN_CLAIMS,
  claimsLength,
  claimsMarks,
  meteredLength,
  meterTone,
  noteMarks,
  readClaims,
  topLevelKeySpans,
} from './claims'

describe('custom claims as Firebase checks them', () => {
  it('counts JavaScript string length of the compact JSON', () => {
    expect(claimsLength('{"n":"é"}')).toBe(9)
    expect(claimsLength('{"n":"🔥"}')).toBe(10)
    expect(claimsLength('{\n  "role": "admin"\n}')).toBe('{"role":"admin"}'.length)
  })

  it('meters any JSON, reserved keys and non-objects included, and nothing else', () => {
    expect(meteredLength('')).toBe(2)
    expect(meteredLength('{\n  "sub": "x"\n}')).toBe('{"sub":"x"}'.length)
    expect(meteredLength('["admin"]')).toBe(9)
    expect(meteredLength('{"n":"🔥"}')).toBe(10)
    expect(meteredLength('{"role": ')).toBeUndefined()
  })

  it('marks text that is not JSON where it stops', () => {
    const marks = claimsMarks('{"role": "admin",}')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.severity).toBe('error')
    expect(marks[0]?.message).toMatch(/^This is not JSON yet/)
    expect(marks[0]?.from).toBeGreaterThan(10)
  })

  it('marks an array or a scalar as not an object', () => {
    expect(claimsMarks('["admin"]')[0]?.message).toMatch(/INVALID_CLAIMS/)
    expect(claimsMarks('3')[0]?.message).toMatch(/INVALID_CLAIMS/)
    expect(readClaims('null')).toEqual(expect.objectContaining({ ok: false }))
  })

  it('marks every one of the sixteen reserved names on its own key', () => {
    expect(FORBIDDEN_CLAIMS).toHaveLength(16)
    for (const name of FORBIDDEN_CLAIMS) {
      const text = `{"role": "x", "${name}": 1}`
      const marks = claimsMarks(text)
      expect(marks).toHaveLength(1)
      expect(text.slice(marks[0]?.from, marks[0]?.to)).toBe(`"${name}"`)
      expect(marks[0]?.message).toBe(
        `\`${name}\` is reserved; Firebase refuses it (FORBIDDEN_CLAIM).`,
      )
    }
    // A nested key of the same name is not a claim.
    expect(claimsMarks('{"org": {"iss": 1}}')).toEqual([])
  })

  it('reads the meter quiet, amber from 900 and red over 1,000', () => {
    expect(meterTone(412)).toBe('quiet')
    expect(meterTone(900)).toBe('crowded')
    expect(meterTone(CLAIMS_LIMIT)).toBe('crowded')
    expect(meterTone(CLAIMS_LIMIT + 1)).toBe('over')
  })

  it('refuses what Firebase refuses before Save is pressed', () => {
    const big = `{"k":"${'x'.repeat(CLAIMS_LIMIT)}"}`
    expect(readClaims(big)).toEqual({
      ok: false,
      message: 'Custom claims are over 1,000 characters; Firebase refuses them (CLAIMS_TOO_LARGE).',
    })
    expect(readClaims('{"sub": "x"}')).toEqual(expect.objectContaining({ ok: false }))
    expect(readClaims('')).toEqual({ ok: true, claims: {}, compact: '{}', length: 2 })
    expect(readClaims('{ "admin": true }')).toEqual({
      ok: true,
      claims: { admin: true },
      compact: '{"admin":true}',
      length: 14,
    })
  })

  it('finds top-level keys, even half typed', () => {
    expect(topLevelKeySpans('{"a": {"b": 1}, "c": [1, {"d": 2}], "e')).toEqual([
      { key: 'a', from: 1, to: 4 },
      { key: 'c', from: 16, to: 19 },
    ])
  })

  it('marks the keys the minted token replaces or that replace a profile claim', () => {
    const text = '{"email": "x@y", "name": "N"}'
    const marks = noteMarks(text, {
      shadowed: [{ key: 'email', reason: 'Auth sets email from the account.' }],
      overrides: [{ key: 'name', reason: 'Replaces the profile name.' }],
    })
    expect(marks.map((mark) => [text.slice(mark.from, mark.to), mark.severity])).toEqual([
      ['"email"', 'warning'],
      ['"name"', 'info'],
    ])
  })
})

describe('editing helpers', () => {
  it('adds a key other users carry, once, keeping what is there', async () => {
    const { addClaimKey, formatClaims } = await import('./claims')
    expect(addClaimKey('', 'role', 'admin')).toBe('{\n  "role": "admin"\n}')
    expect(JSON.parse(addClaimKey('{"plan":"pro"}', 'role', undefined))).toEqual({
      plan: 'pro',
      role: null,
    })
    expect(addClaimKey('{"role":"x"}', 'role', 'admin')).toBe('{"role":"x"}')
    expect(addClaimKey('{"role":', 'plan', 1)).toBe('{"role":')
    expect(formatClaims('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(formatClaims('{')).toBeUndefined()
  })
})
