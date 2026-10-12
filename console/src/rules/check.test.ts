import { describe, expect, it } from 'vitest'
import { textToCheck } from './check'

const key = (scope: string, text: string) => `${scope}\u0000${text}`

describe('the text a rules page checks', () => {
  it('is nothing before the rules arrive: the empty editor is never checked', () => {
    expect(textToCheck('(default)', undefined, undefined)).toBeUndefined()
  })

  it('is the loaded text at once, not after the typing pause', () => {
    expect(textToCheck('(default)', key('(default)', 'service x {}'), undefined)).toBe(
      'service x {}',
    )
  })

  it('is the settled text while the next one is typed', () => {
    expect(
      textToCheck(
        '(default)',
        key('(default)', 'service x {} //'),
        key('(default)', 'service x {}'),
      ),
    ).toBe('service x {}')
  })

  it('never carries the text of the scope the picker just left', () => {
    expect(textToCheck('shop', key('shop', 'shop rules'), key('(default)', 'old rules'))).toBe(
      'shop rules',
    )
    expect(textToCheck('shop', undefined, key('(default)', 'old rules'))).toBeUndefined()
  })

  it('keeps an empty ruleset that was loaded as the text to check', () => {
    expect(textToCheck('b', key('b', ''), undefined)).toBe('')
  })
})
