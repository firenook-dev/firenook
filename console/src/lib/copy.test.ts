import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToastOptions } from './toasts'

const shown = vi.hoisted(() => [] as ToastOptions[])
vi.mock('./toasts', () => ({ toast: (options: ToastOptions) => shown.push(options) }))

const { COPY_TOAST, copyToClipboard } = await import('./copy')

function clipboard(write: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { clipboard: { writeText: write } })
}

afterEach(() => {
  shown.length = 0
  vi.unstubAllGlobals()
})

describe('copying', () => {
  it('puts the text on the clipboard and says what it was', async () => {
    const written: string[] = []
    clipboard(async (text) => void written.push(text))
    expect(await copyToClipboard('u_9f3k2', { what: 'the uid' })).toBe(true)
    expect(written).toEqual(['u_9f3k2'])
    expect(shown).toEqual([
      { key: COPY_TOAST, title: 'Copied the uid', description: undefined, tone: 'success' },
    ])
  })

  it('takes a whole title, a line under it and a key of its own', async () => {
    clipboard(async () => {})
    await copyToClipboard('gs://b/a.png', {
      title: 'Copied the gs:// URL',
      description: 'gs://b/a.png',
      key: 'storage.copy',
    })
    expect(shown).toEqual([
      {
        key: 'storage.copy',
        title: 'Copied the gs:// URL',
        description: 'gs://b/a.png',
        tone: 'success',
      },
    ])
  })

  it('says nothing on success when nothing names it: a button’s tick says it', async () => {
    clipboard(async () => {})
    expect(await copyToClipboard('x')).toBe(true)
    expect(shown).toEqual([])
  })

  it('says when the browser refused, and what to do instead, without throwing', async () => {
    clipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    expect(await copyToClipboard('x')).toBe(false)
    expect(
      await copyToClipboard('482913', { what: 'the code', refused: 'The code is 482913.' }),
    ).toBe(false)
    expect(shown.map((toast) => [toast.title, toast.description, toast.tone])).toEqual([
      [
        'The browser did not let the console copy',
        'Select the text and copy it yourself.',
        'warning',
      ],
      ['The browser did not let the console copy', 'The code is 482913.', 'warning'],
    ])
  })
})
