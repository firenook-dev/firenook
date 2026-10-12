import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { download, filenameOf } from './download'

/** Every anchor the helper clicks: its href and download name. */
function watchClicks() {
  const clicks: Array<{ href: string; download: string; attached: boolean }> = []
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.href, download: this.download, attached: this.isConnected })
  })
  return { clicks, click }
}

describe('saving a file', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
  })

  it('follows an href the engine streams with an anchor, holding nothing in memory', async () => {
    const { clicks } = watchClicks()
    const blob = vi.spyOn(URL, 'createObjectURL')
    await download('/console/api/v1/logs/export?format=ndjson', 'logs.ndjson')
    expect(clicks).toEqual([
      {
        href: `${location.origin}/console/api/v1/logs/export?format=ndjson`,
        download: 'logs.ndjson',
        attached: true,
      },
    ])
    expect(blob).not.toHaveBeenCalled()
    expect(document.querySelector('a[download]')).toBeNull()
  })

  it('pipes a response to the file the person picks when the browser can', async () => {
    const written: string[] = []
    const picker = vi.fn(async () => ({
      createWritable: async () =>
        new WritableStream<Uint8Array>({
          write: (chunk) => {
            written.push(new TextDecoder().decode(chunk))
          },
        }),
    }))
    ;(window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = picker
    const { clicks } = watchClicks()
    await download(
      async () =>
        new Response('{"a":1}\n{"a":2}\n', {
          headers: { 'content-disposition': 'attachment; filename="users.ndjson"' },
        }),
    )
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'users.ndjson' })
    expect(written.join('')).toBe('{"a":1}\n{"a":2}\n')
    expect(clicks).toHaveLength(0)
  })

  it('treats a cancelled save dialog as a choice, not an error', async () => {
    ;(window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => {
      throw new DOMException('The user aborted a request.', 'AbortError')
    }
    const { clicks } = watchClicks()
    await expect(download(async () => new Response('x'), 'x.txt')).resolves.toBeUndefined()
    expect(clicks).toHaveLength(0)
  })

  it('falls back to a Blob where the browser has no file picker', async () => {
    const { clicks } = watchClicks()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:console/1')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      await download(async () => new Response('a,b\n1,2\n'), 'rows.csv')
      expect(create).toHaveBeenCalledTimes(1)
      expect(clicks).toEqual([{ href: 'blob:console/1', download: 'rows.csv', attached: true }])
      expect(revoke).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(revoke).toHaveBeenCalledWith('blob:console/1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects with the engine error when the answer is not a file', async () => {
    const failing = download(
      async () =>
        new Response(JSON.stringify({ error: { code: 'not-found', message: 'No such export.' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(failing).rejects.toBeInstanceOf(ApiError)
    await expect(failing).rejects.toMatchObject({ status: 404, message: 'No such export.' })
  })
})

const named = (header: string) =>
  filenameOf(new Response('', { headers: { 'content-disposition': header } }))

describe("the engine's file name", () => {
  it('reads plain, quoted and UTF-8 names', () => {
    expect(named('attachment; filename="export.json"')).toBe('export.json')
    expect(named('attachment; filename=export.json')).toBe('export.json')
    expect(named('attachment; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.json; filename="r.json"')).toBe(
      'résumé.json',
    )
    expect(filenameOf(new Response(''))).toBeUndefined()
  })
})
