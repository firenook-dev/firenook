import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useLocalBadges } from '@/lib/badges'
import UploadsBeacon, { UPLOADS_BADGE } from './uploads-beacon'
import source from './uploads-beacon.tsx?raw'
import { useUploadQueue } from './upload-queue-store'

const reset = () =>
  useUploadQueue.setState({
    items: [],
    totals: { files: 0, bytes: 0, finished: 0, sentBytes: 0 },
    open: false,
    collapsed: false,
  })

describe('the uploads beacon', () => {
  afterEach(reset)

  it('puts up "N uploading" and asks before the tab closes while bytes are in flight', () => {
    render(<UploadsBeacon />)
    expect(useLocalBadges.getState().badges.get(UPLOADS_BADGE)).toBeUndefined()
    act(() =>
      useUploadQueue.getState().add([
        { id: 'a', bucket: 'b', name: 'a', size: 1, loaded: 0, state: 'uploading' },
        { id: 'b', bucket: 'b', name: 'b', size: 1, loaded: 0, state: 'queued' },
      ]),
    )
    expect(useLocalBadges.getState().badges.get(UPLOADS_BADGE)).toEqual({
      count: 2,
      tone: 'neutral',
      noun: { one: 'upload in progress', other: 'uploads in progress' },
    })
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    act(() => {
      useUploadQueue.getState().patch('a', { state: 'done' })
      useUploadQueue.getState().patch('b', { state: 'done' })
    })
    expect(useLocalBadges.getState().badges.get(UPLOADS_BADGE)).toBeUndefined()
    const later = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(later)
    expect(later.defaultPrevented).toBe(false)
  })

  it('imports nothing of the section but the queue store', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])
    expect(imports).toEqual(['react', '@/lib/badges', './upload-queue-store'])
  })
})
