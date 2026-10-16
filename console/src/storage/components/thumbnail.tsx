// A tile's picture. The engine makes a small JPEG or PNG of a large image
// (cached by generation, then by the browser for ever); SVG, AVIF, ICO and
// any image of at most 256 KB come from the media route itself, which the
// browser draws as it is. Its `src` is set when the tile's turn comes in the
// tab's pool of long requests (`net.ts`) — tiles in view order, after the
// inspector's preview — never by `loading="lazy"`; a tile that scrolls away
// before its turn leaves the queue, and one that scrolls away mid-load
// clears its `src`, which cancels the request. A failed or unsupported
// picture falls back to the type's icon, in a box that never changes size.
//
// While the page acts as a client, a file the access check says the
// identity may not read draws a lock and the refusing line, and nothing is
// requested: an `<img>` cannot carry the identity's token.

import { cn } from '@cloudflare/kumo'
import { LockSimpleIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { StorageFileEntry } from '@/api/generated/storage/StorageFileEntry'
import { mediaUrl, thumbnailUrl } from '../api'
import { essence, fileFamily } from '../mime'
import { type Release, storagePool } from '../net'
import { FileIcon } from './file-icon'

/** Images up to this size are drawn from the media route, not thumbnailed. */
export const SMALL_IMAGE = 256 * 1024

/** Types the browser draws itself and the engine does not decode. */
const DRAWN_AS_IS = new Set([
  'image/svg+xml',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])

/** Where a file's picture comes from, or `undefined` for a file that has none. */
export function pictureUrl(bucket: string, file: StorageFileEntry): string | undefined {
  if (fileFamily(file.contentType, file.name) !== 'image') return undefined
  const type = essence(file.contentType)
  const object = { bucket, name: file.name, generation: file.generation }
  if (DRAWN_AS_IS.has(type) || file.size <= SMALL_IMAGE) return mediaUrl(object)
  return thumbnailUrl({ ...object, width: 320 })
}

/** A checkerboard under a picture, so transparency reads as transparency. */
export const CHECKERBOARD =
  '[background:repeating-conic-gradient(var(--color-kumo-tint)_0%_25%,var(--color-kumo-base)_0%_50%)_50%/16px_16px]'

/** The file's extension in the data face, under its icon. */
function extension(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * A picture still loading when its tile leaves the view stops: clearing the
 * source cancels the request (a callback ref's cleanup runs as it leaves).
 */
function cancelOnLeave(element: HTMLImageElement | null) {
  if (!element) return undefined
  return () => {
    if (!element.complete) element.removeAttribute('src')
  }
}

export function Thumbnail({
  bucket,
  file,
  order,
  read,
  refusingLine,
}: {
  bucket: string
  file: StorageFileEntry
  /** The tile's place in the list: earlier tiles get their turn first. */
  order: number
  /** May the identity read it: `true` (or Admin), `false` refused, `undefined` not known yet. */
  read: boolean | undefined
  refusingLine?: number | null | undefined
}) {
  const url = read === true ? pictureUrl(bucket, file) : undefined
  const [src, setSrc] = useState<string | undefined>(undefined)
  const [state, setState] = useState<{ url: string | undefined; failed: boolean }>({
    url,
    failed: false,
  })
  if (state.url !== url) setState({ url, failed: false })
  const failed = state.url === url && state.failed
  const release = useRef<Release | undefined>(undefined)
  const firstOrder = useRef(order)

  useEffect(() => {
    if (url === undefined) return undefined
    const controller = new AbortController()
    let granted: Release | undefined
    storagePool
      .acquire('tile', { order: firstOrder.current, signal: controller.signal })
      .then((done) => {
        granted = done
        release.current = done
        setSrc(url)
      })
      .catch(() => {
        // Left the view before its turn: nothing was requested.
      })
    return () => {
      controller.abort()
      granted?.()
      release.current = undefined
    }
  }, [url])

  const done = () => {
    release.current?.()
    release.current = undefined
  }

  if (read === false)
    return (
      <span
        className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-kumo-tint"
        data-testid="tile-locked"
      >
        <LockSimpleIcon size={24} className="text-kumo-danger" aria-hidden />
        <span className="text-[11px] text-kumo-subtle">
          No read{refusingLine ? ` · line ${refusingLine}` : ''}
        </span>
      </span>
    )
  // The access check has not answered yet: nothing is drawn or asked for.
  if (read === undefined) return <span className="block h-full w-full animate-pulse bg-kumo-tint" />
  if (url === undefined || failed)
    return (
      <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-kumo-tint">
        <FileIcon contentType={file.contentType} name={file.name} size={32} />
        <span className="font-mono text-[11px] text-kumo-subtle">{extension(file.name)}</span>
      </span>
    )
  return (
    // The checkerboard sits under the picture's own pixels, not the
    // letterbox around it, so an opaque image reads as an image.
    <span className="flex h-full w-full items-center justify-center bg-kumo-tint">
      {src !== undefined && src === url && (
        <img
          ref={cancelOnLeave}
          src={src}
          alt=""
          decoding="async"
          draggable={false}
          className={cn('max-h-full max-w-full object-contain', CHECKERBOARD)}
          onLoad={done}
          onError={() => {
            done()
            setState({ url, failed: true })
          }}
          data-testid="tile-image"
        />
      )}
    </span>
  )
}
