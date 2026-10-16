import { describe, expect, it, vi } from 'vitest'
import {
  IMPORT_PREFIX_BYTES,
  NOT_AN_EXPORT,
  detectImportShape,
  recogniseImportFile,
} from './import'

describe('recognising a users file from its first bytes', () => {
  it('knows the emulator export by its kind before its users', () => {
    expect(
      detectImportShape(
        '{"kind":"identitytoolkit#DownloadAccountResponse","users":[{"localId":"a"',
      ),
    ).toEqual({ ok: true, shape: 'emulator', label: 'An emulator export (accounts.json)' })
  })

  it('reads a CLI export, and an object whose users come later than the prefix', () => {
    expect(
      detectImportShape('{\n  "users": [\n    {"localId": "a", "lastSignedInAt": "1"}'),
    ).toEqual(expect.objectContaining({ ok: true, shape: 'cli' }))
    // Cut inside a string: still an object on its way to its users.
    expect(detectImportShape('{"note": "a long description that stops he')).toEqual(
      expect.objectContaining({ ok: true, shape: 'cli' }),
    )
  })

  it('reads a plain array, a BOM and leading space included', () => {
    expect(detectImportShape('﻿  [{"localId": "a"}')).toEqual(
      expect.objectContaining({ ok: true, shape: 'array' }),
    )
  })

  it('says at once when the file is something else', () => {
    expect(detectImportShape('{"documents": []}')).toEqual({ ok: false, message: NOT_AN_EXPORT })
    expect(detectImportShape('{"users": "nope"}')).toEqual({ ok: false, message: NOT_AN_EXPORT })
    expect(detectImportShape('localId,email\na,b')).toEqual({ ok: false, message: NOT_AN_EXPORT })
    expect(detectImportShape('   ')).toEqual({ ok: false, message: 'This file is empty.' })
  })

  it('never reads past the first 64 KB', async () => {
    const big = new Blob([`[${'{"localId":"x"},'.repeat(20_000)}{}]`])
    const slice = vi.spyOn(big, 'slice')
    const recognised = await recogniseImportFile(big)
    expect(recognised).toEqual(expect.objectContaining({ ok: true, shape: 'array' }))
    expect(slice).toHaveBeenCalledWith(0, IMPORT_PREFIX_BYTES)
  })
})
