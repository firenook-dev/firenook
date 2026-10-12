import { beforeEach, describe, expect, it } from 'vitest'
import { type UploadItem, inFlight, pruneFinished, useUploadQueue } from './upload-queue-store'

const item = (id: string, state: UploadItem['state'], size = 10): UploadItem => ({
  id,
  bucket: 'b',
  name: id,
  size,
  loaded: 0,
  state,
})

describe('the upload queue’s data', () => {
  beforeEach(() =>
    useUploadQueue.setState({
      items: [],
      totals: { files: 0, bytes: 0, finished: 0, sentBytes: 0 },
      open: false,
      collapsed: false,
    }),
  )

  it('keeps the last thousand finished rows and every active one', () => {
    const items = [
      ...Array.from({ length: 1_005 }, (_, index) => item(`d${index}`, 'done')),
      item('a', 'uploading'),
    ]
    const kept = pruneFinished(items)
    expect(kept).toHaveLength(1_001)
    expect(kept[0]?.id).toBe('d5')
    expect(kept.at(-1)?.id).toBe('a')
  })

  it('counts what is in flight', () => {
    expect(
      inFlight([
        { ...item('a', 'uploading', 100), loaded: 40 },
        item('b', 'queued', 50),
        item('c', 'done'),
      ]),
    ).toEqual({
      count: 2,
      bytes: 150,
      loaded: 40,
    })
  })

  it('keeps running totals as rows finish', () => {
    const { add, patch } = useUploadQueue.getState()
    add([item('a', 'queued', 5), item('b', 'queued', 7)])
    patch('a', { state: 'done', loaded: 5 })
    patch('b', { state: 'failed' })
    expect(useUploadQueue.getState().totals).toEqual({
      files: 2,
      bytes: 12,
      finished: 2,
      sentBytes: 5,
    })
    patch('b', { state: 'queued' })
    expect(useUploadQueue.getState().totals.finished).toBe(1)
  })

  it('clears what finished and closes when nothing is left', () => {
    const { add, patch, clearFinished } = useUploadQueue.getState()
    add([item('a', 'queued')])
    patch('a', { state: 'done' })
    clearFinished()
    expect(useUploadQueue.getState()).toMatchObject({ items: [], open: false })
  })
})
