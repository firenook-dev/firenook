import { afterEach, describe, expect, it } from 'vitest'
import { usePlayground } from './playground-store'
import { EMPTY_FORM } from './requests'

describe('the playground’s store', () => {
  afterEach(() => usePlayground.setState({ form: EMPTY_FORM, run: undefined, pending: false }))

  it('holds a request handed over to be tried until the playground takes it', () => {
    const form = { ...EMPTY_FORM, path: 'users/u1/a.png' }
    usePlayground.getState().setRun(undefined, 'an earlier failure')
    usePlayground.getState().load(form, { run: true })
    expect(usePlayground.getState()).toMatchObject({ form, pending: true, failure: undefined })
    usePlayground.getState().takePending()
    expect(usePlayground.getState().pending).toBe(false)
  })

  it('loads a request without running it unless asked', () => {
    usePlayground.getState().load({ ...EMPTY_FORM, method: 'list' })
    expect(usePlayground.getState().pending).toBe(false)
    expect(usePlayground.getState().form.method).toBe('list')
  })
})
