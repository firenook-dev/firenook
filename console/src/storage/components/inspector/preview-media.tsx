// Video and audio with the browser's own controls, streamed by range from
// the console's media route; the line under them says what the element
// found: `1920 × 1080 · 0:42`.

import { cn } from '@cloudflare/kumo'
import { useState } from 'react'
import { formatNumber } from '@/lib/format'
import { usePreviewSlot } from './use-slot'

/** `0:42`, `1:02:05`. */
export function mediaDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return ''
  const whole = Math.round(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = String(whole % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

export function PreviewMedia({
  url,
  kind,
  large = false,
}: {
  url: string
  kind: 'video' | 'audio'
  large?: boolean
}) {
  const { src, done } = usePreviewSlot(url)
  const [facts, setFacts] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const loaded = (element: HTMLMediaElement) => {
    done()
    const parts: string[] = []
    if (element instanceof HTMLVideoElement && element.videoWidth > 0)
      parts.push(`${formatNumber(element.videoWidth)} × ${formatNumber(element.videoHeight)}`)
    const length = mediaDuration(element.duration)
    if (length) parts.push(length)
    setFacts(parts.join(' · '))
  }
  if (failed)
    return (
      <p className="rounded-md bg-kumo-tint px-3 py-6 text-center text-[13px] text-kumo-subtle">
        The browser cannot play this {kind === 'video' ? 'video' : 'audio'}; download it to open it
        elsewhere.
      </p>
    )
  return (
    <div className={cn('grid gap-1.5', large && 'h-full grid-rows-[minmax(0,1fr)_auto]')}>
      {src &&
        (kind === 'video' ? (
          <video
            src={src}
            controls
            preload="metadata"
            className={cn('w-full rounded-md bg-kumo-tint', large ? 'h-full' : 'max-h-80')}
            onLoadedMetadata={(event) => loaded(event.currentTarget)}
            onError={() => {
              done()
              setFailed(true)
            }}
            data-testid="preview-video"
          />
        ) : (
          <audio
            src={src}
            controls
            preload="metadata"
            className="w-full"
            onLoadedMetadata={(event) => loaded(event.currentTarget)}
            onError={() => {
              done()
              setFailed(true)
            }}
            data-testid="preview-audio"
          />
        ))}
      <span
        className="font-mono text-[11px] text-kumo-subtle tabular-nums"
        data-testid="preview-media-facts"
      >
        {facts}
      </span>
    </div>
  )
}
