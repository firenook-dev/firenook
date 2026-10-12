import { describe, expect, it } from 'vitest'
import { testStatus } from '@/test/status'
import { describeData, shortPath } from './engine-popover'

describe('the engine popover’s facts', () => {
  it('say where the data lives and whether it survives a restart', () => {
    const data = testStatus().data
    expect(describeData(data)).toBe('in memory · gone when the engine stops')
    expect(describeData({ ...data, mode: 'disk' })).toBe('on disk')
    expect(describeData({ ...data, mode: 'disk', resumed: true })).toBe('on disk · resumed')
  })

  it('keep a long path’s end, which names the folder', () => {
    expect(shortPath('./export')).toBe('./export')
    expect(
      shortPath('/var/folders/17/97zrc8dn5kj9m8sn51kc0h3w0000gn/T/firenook-console-data-x/state'),
    ).toBe('…/T/firenook-console-data-x/state')
    expect(shortPath('/a/very-long-folder-name-that-fills-the-whole-row-by-itself')).toBe(
      '…/very-long-folder-name-that-fills-the-whole-row-by-itself',
    )
  })
})
