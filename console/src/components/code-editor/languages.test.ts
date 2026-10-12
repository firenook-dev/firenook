import { describe, expect, it } from 'vitest'
import { isPreviewLanguage, loadPreviewLanguage } from './languages'

describe('the preview languages', () => {
  it('are told apart from the editor’s own', () => {
    expect(isPreviewLanguage('markdown')).toBe(true)
    expect(isPreviewLanguage('text')).toBe(true)
    expect(isPreviewLanguage('json')).toBe(false)
    expect(isPreviewLanguage('rules')).toBe(false)
    expect(isPreviewLanguage(undefined)).toBe(false)
  })

  it('load a grammar for each, and none for plain text', async () => {
    const grammars = await Promise.all(
      (['javascript', 'xml', 'yaml', 'markdown', 'css', 'html'] as const).map(loadPreviewLanguage),
    )
    for (const grammar of grammars) expect(grammar).toBeTruthy()
    expect(await loadPreviewLanguage('text')).toEqual([])
  })
})
