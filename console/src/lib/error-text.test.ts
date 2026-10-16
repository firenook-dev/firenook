import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { errorText } from './error-text'

describe('errorText', () => {
  it('says an engine refusal and then its fix', () => {
    const refused = new ApiError(409, 'The topic exists.', 'conflict', 'Pick another name.')
    expect(errorText(refused)).toBe('The topic exists. Pick another name.')
    expect(errorText(new ApiError(404, 'No such topic.', 'not-found'))).toBe('No such topic.')
  })

  it('says any other failure as its message', () => {
    expect(errorText(new TypeError('Failed to fetch'))).toBe('Failed to fetch')
    expect(errorText('stopped')).toBe('stopped')
  })
})
