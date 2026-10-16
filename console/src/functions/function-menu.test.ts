import { describe, expect, it, vi } from 'vitest'
import { functionMenu, reloadRefusal } from './function-menu'
import { codebase, summary } from './fixtures.test-support'

describe("a function's menu", () => {
  it('lists the same items in the same order wherever it is offered', () => {
    const items = functionMenu(summary('api'), codebase('default').codebase, {
      open: vi.fn(),
      run: vi.fn(),
      copy: vi.fn(),
      url: 'http://127.0.0.1:5001/p/us-central1/api',
      logs: vi.fn(),
      invocations: vi.fn(),
      openCodebase: vi.fn(),
      reload: vi.fn(),
      restart: vi.fn(),
    })
    expect(items.map((item) => item.label)).toEqual([
      'Open',
      'Invoke',
      'Copy URL',
      'Copy id',
      'Open in Logs',
      'Show all invocations',
      'Open codebase',
      'Reload codebase',
      'Restart worker…',
    ])
  })

  it('copies through the caller and keeps an extension codebase from reloading here', () => {
    const copy = vi.fn()
    const items = functionMenu(
      summary('greet'),
      codebase('greeter', { kind: 'extension' }).codebase,
      {
        copy,
        invocations: vi.fn(),
        reload: vi.fn(),
      },
    )
    items.find((item) => item.id === 'copy-id')?.run()
    expect(copy).toHaveBeenCalledWith('us-central1-greet', 'the id')
    expect(items.find((item) => item.id === 'reload')?.disabled).toBe(
      reloadRefusal({ kind: 'extension' }),
    )
    expect(reloadRefusal({ kind: 'user' })).toBeUndefined()
  })
})
