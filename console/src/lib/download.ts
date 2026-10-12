// Saving a file from the console without holding it in memory when that can
// be avoided. An export of a large collection or a day of logs can be
// hundreds of megabytes; assembled into a Blob first it is held twice (the
// response and the Blob) before the browser writes a byte.
//
// - An `href` the engine streams is followed by an `<a download>`: the
//   browser's own download manager reads it, nothing passes through script.
// - A Response (an answer to a POST, which an anchor cannot make) is piped
//   to the file through the File System Access API where the browser has it,
//   chunk by chunk.
// - Elsewhere, a Blob, as the last resort.

import { ApiError } from '@/api/client'

interface SaveFilePicker {
  (options: { suggestedName?: string }): Promise<{
    createWritable(): Promise<WritableStream<Uint8Array>>
  }>
}

/**
 * Saves a file: an `href` the engine streams (an `<a download>`, nothing held
 * in memory), or a Response (a POST answer) piped to a file through the File
 * System Access API when available, else a Blob as the last resort.
 * Resolves once the file is handed to the browser; rejects with the engine's
 * error when the answer is not a file, and quietly when the person cancels
 * the save dialog.
 */
export async function download(
  source: string | (() => Promise<Response>),
  filename?: string,
): Promise<void> {
  if (typeof source === 'string') {
    clickAnchor(source, filename)
    return
  }
  const response = await source()
  if (!response.ok) throw await errorOf(response)
  const name = filename ?? filenameOf(response) ?? 'download'
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  if (picker && response.body) {
    let handle: Awaited<ReturnType<SaveFilePicker>>
    try {
      handle = await picker({ suggestedName: name })
    } catch (error) {
      // Cancelling the dialog is a choice, not a failure; anything else
      // (a page without the permission) falls through to the Blob.
      if (error instanceof DOMException && error.name === 'AbortError') {
        await response.body.cancel()
        return
      }
      return saveBlob(response, name)
    }
    await response.body.pipeTo(await handle.createWritable())
    return
  }
  return saveBlob(response, name)
}

async function saveBlob(response: Response, name: string): Promise<void> {
  const url = URL.createObjectURL(await response.blob())
  try {
    clickAnchor(url, name)
  } finally {
    // The click has started the download; the URL is no longer needed once
    // the browser has read it, which it does before the next task.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

function clickAnchor(href: string, filename: string | undefined) {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename ?? ''
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

/** The name the engine gave the file, from `Content-Disposition`. */
export function filenameOf(response: Response): string | undefined {
  const header = response.headers.get('content-disposition')
  if (!header) return undefined
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim())
    } catch {
      // A malformed extended name falls back to the plain one.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header)
  return (plain?.[2] ?? plain?.[1])?.trim() || undefined
}

async function errorOf(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`.trim()
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    if (body.error?.message) message = body.error.message
  } catch {
    // Not JSON: the status line is the message.
  }
  return new ApiError(response.status, message)
}
