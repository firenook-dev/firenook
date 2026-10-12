import { describe, expect, it } from 'vitest'
import { nextProblem, problemsOf } from './problems'

const problem = (severity: string, line: number, message = 'x') => ({
  severity,
  message,
  line,
  column: 1,
})

describe('the problems of a text', () => {
  it('lists each once, errors first, then by line', () => {
    const checked = [problem('warning', 2), problem('error', 9), problem('warning', 1)]
    const rejected = [problem('error', 9), problem('error', 4)]
    expect(problemsOf(checked, rejected).map((item) => `${item.severity}:${item.line}`)).toEqual([
      'error:4',
      'error:9',
      'warning:1',
      'warning:2',
    ])
  })
})

describe('walking the problems with F8', () => {
  const problems = [problem('error', 7), problem('warning', 3), problem('warning', 12)]

  it('goes to the next line after the caret, and wraps', () => {
    expect(nextProblem(problems, 3)?.line).toBe(7)
    expect(nextProblem(problems, 7)?.line).toBe(12)
    expect(nextProblem(problems, 12)?.line).toBe(3)
  })

  it('goes back with Shift, and wraps the other way', () => {
    expect(nextProblem(problems, 7, true)?.line).toBe(3)
    expect(nextProblem(problems, 3, true)?.line).toBe(12)
  })

  it('starts at the first, or the last, with no caret, and finds nothing in a clean text', () => {
    expect(nextProblem(problems, undefined)?.line).toBe(3)
    expect(nextProblem(problems, undefined, true)?.line).toBe(12)
    expect(nextProblem([], 4)).toBeUndefined()
  })
})
