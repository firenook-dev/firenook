import { describe, expect, it } from 'vitest'
import { inlineSteps } from './explain'

const source = 'allow read: if request.auth.uid == uid && f(uid);'
const at = (text: string) => source.indexOf(text)
const step = (text: string, value: string, start = at(text)) => ({
  from: start,
  to: start + text.length,
  value,
  error: false,
})

describe('the values written into the editor', () => {
  it('keeps whole operands and comparisons, not the prefixes of a member chain', () => {
    const steps = [
      step('request', 'request'),
      step('request.auth', 'null'),
      step('request.auth.uid', 'null'),
      step('uid', '"u1"', at('== uid') + 3),
      step('request.auth.uid == uid', 'false'),
    ]
    expect(inlineSteps(steps, source).map((item) => item.value)).toEqual(['null', '"u1"', 'false'])
  })

  it('keeps the callee name out but the call in', () => {
    const steps = [step('f', 'function', at('f(')), step('f(uid)', 'true', at('f('))]
    expect(inlineSteps(steps, source).map((item) => item.value)).toEqual(['true'])
  })

  it('shows the last value of a span evaluated more than once', () => {
    const steps = [step('f(uid)', 'false', at('f(')), step('f(uid)', 'true', at('f('))]
    expect(inlineSteps(steps, source)).toEqual([
      { from: at('f('), to: at('f(') + 6, value: 'true', error: false },
    ])
  })
})
