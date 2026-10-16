// A preview's turn in the tab's pool of long requests: the source is set
// once the slot is granted (the preview goes before tiles and uploads), and
// the slot is given back when the picture or the media has loaded, failed,
// or left the screen.

import { useEffect, useRef, useState } from 'react'
import { type Release, storagePool } from '../../net'

/** `src` once `url` has its slot; call `done` when it has loaded or failed. */
export function usePreviewSlot(url: string | undefined): {
  src: string | undefined
  done: () => void
} {
  const [granted, setGranted] = useState<string | undefined>(undefined)
  const release = useRef<Release | undefined>(undefined)
  useEffect(() => {
    if (url === undefined) return undefined
    const controller = new AbortController()
    let held: Release | undefined
    storagePool
      .acquire('preview', { signal: controller.signal })
      .then((next) => {
        held = next
        release.current = next
        setGranted(url)
      })
      .catch(() => {
        // Closed before its turn: nothing was requested.
      })
    return () => {
      controller.abort()
      held?.()
      release.current = undefined
    }
  }, [url])
  return {
    src: granted !== undefined && granted === url ? url : undefined,
    done: () => {
      release.current?.()
      release.current = undefined
    },
  }
}
