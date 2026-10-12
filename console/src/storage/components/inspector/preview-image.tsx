// An image, fitted to the panel or at its own size, on a checkerboard so
// transparency reads as transparency, with its natural size under it.

import { Button, cn } from '@cloudflare/kumo'
import { useState } from 'react'
import { formatNumber } from '@/lib/format'
import { CHECKERBOARD } from '../thumbnail'
import { usePreviewSlot } from './use-slot'

export function PreviewImage({ url, large = false }: { url: string; large?: boolean }) {
  const { src, done } = usePreviewSlot(url)
  const [actual, setActual] = useState(false)
  const [natural, setNatural] = useState<{ width: number; height: number } | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  return (
    <div className={cn('grid min-h-0 gap-1.5', large && 'h-full grid-rows-[minmax(0,1fr)_auto]')}>
      <div
        className={cn(
          'flex min-h-40 items-center justify-center overflow-auto rounded-md bg-kumo-tint',
          large ? 'h-full' : 'max-h-80',
        )}
        data-testid="preview-image-box"
      >
        {failed ? (
          <span className="text-[13px] text-kumo-subtle">
            The browser could not draw this image.
          </span>
        ) : (
          src && (
            <img
              src={src}
              alt=""
              decoding="async"
              className={cn(
                CHECKERBOARD,
                actual ? 'max-w-none' : 'max-h-full max-w-full object-contain',
              )}
              onLoad={(event) => {
                done()
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }}
              onError={() => {
                done()
                setFailed(true)
              }}
              data-testid="preview-image"
            />
          )
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
          {natural ? `${formatNumber(natural.width)} × ${formatNumber(natural.height)}` : ''}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setActual((value) => !value)}
          aria-pressed={actual}
          data-testid="preview-image-scale"
        >
          {actual ? 'Fit' : '1:1'}
        </Button>
      </div>
    </div>
  )
}
