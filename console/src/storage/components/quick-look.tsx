// Quick Look: the file in view, large, over everything — ←/→ through the
// files of the listing (the next page read when the end is reached), the
// inspector one click away, Esc (the first press) or Shift+Space to close. `dialog=quick-look`
// in the address, so a link opens it. A file this identity may not read
// shows the refusal, never the picture.

import { Button, Dialog, Text, Tooltip } from '@cloudflare/kumo'
import {
  CaretLeftIcon,
  CaretRightIcon,
  LockKeyIcon,
  SidebarSimpleIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { formatBytes, formatNumber } from '@/lib/format'
import { describeViewAsShort } from '@/lib/identity'
import { StorageApiError } from '../api'
import { useFiles } from '../files-state'
import { baseName } from '../paths'
import { objectQuery } from '../queries'
import { Preview } from './inspector/preview'
import { RefusalDetail } from './refusal-detail'

export function QuickLook({
  names,
  hasMore,
  loadMore,
}: {
  /** The files of the listing, in view order. */
  names: readonly string[]
  hasMore: boolean
  loadMore: () => void
}) {
  const files = useFiles()
  const open = files.search.dialog === 'quick-look' && files.object !== undefined
  const name = files.object ?? ''
  const query = useQuery({
    ...objectQuery(files.project, files.bucket, name, files.viewAs),
    enabled: open,
  })
  const at = names.indexOf(name)
  const close = () => files.update({ dialog: undefined }, { replace: true })
  const step = (by: number) => {
    const next = names[at + by]
    if (next !== undefined) files.update({ object: next }, { replace: true })
    else if (by > 0 && hasMore) loadMore()
  }
  const object = query.data
  // Escape closes on the first press. Opened from the keyboard, the dialog
  // focuses its first button, whose tooltip shows and would take that press
  // for itself before the dialog sees it, so the window hears it first.
  const closeRef = useRef(close)
  useLayoutEffect(() => {
    closeRef.current = close
  })
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog className="h-[calc(100vh-4rem)] p-0 sm:top-8 sm:w-[min(1280px,calc(100vw-4rem))]">
        {/* The dialog takes the arrows and Shift+Space from the page while it
            is open: single keys stand aside inside an overlay. */}
        <div
          className="flex h-full min-h-0 flex-col"
          data-testid="quick-look"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              step(event.key === 'ArrowLeft' ? -1 : 1)
            } else if (event.key === ' ' && event.shiftKey) {
              event.preventDefault()
              close()
            }
          }}
        >
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-kumo-line px-4">
            <Dialog.Title className="min-w-0 truncate font-mono text-[13px] font-medium">
              {baseName(name)}
            </Dialog.Title>
            {object && (
              <span className="shrink-0 font-mono text-[12px] text-kumo-subtle">
                {formatBytes(object.size)} · {object.contentType ?? 'no type'}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {at !== -1 && (
                <span
                  className="mr-1 text-[12px] text-kumo-subtle tabular-nums"
                  data-testid="quick-look-position"
                >
                  {formatNumber(at + 1)} of {formatNumber(names.length)}
                  {hasMore ? '+' : ''}
                </span>
              )}
              <Tooltip
                content="Previous file ←"
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    icon={<CaretLeftIcon />}
                    aria-label="Previous file"
                    disabled={at <= 0}
                    onClick={() => step(-1)}
                    data-testid="quick-look-prev"
                  />
                }
              />
              <Tooltip
                content="Next file →"
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    icon={<CaretRightIcon />}
                    aria-label="Next file"
                    disabled={at === -1 || (at >= names.length - 1 && !hasMore)}
                    onClick={() => step(1)}
                    data-testid="quick-look-next"
                  />
                }
              />
              <Button
                variant="ghost"
                size="sm"
                icon={<SidebarSimpleIcon mirrored />}
                onClick={close}
                data-testid="quick-look-inspector"
              >
                Inspector
              </Button>
              <Dialog.Close
                aria-label="Close"
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    icon={<XIcon />}
                    aria-label="Close"
                  />
                }
              />
            </span>
          </header>
          <div className="min-h-0 flex-1 p-4" data-testid="quick-look-body">
            {query.isError ? (
              query.error instanceof StorageApiError && query.error.refused ? (
                <div className="grid h-full place-content-center justify-items-center gap-2 text-center">
                  <LockKeyIcon size={40} className="text-kumo-inactive" />
                  <Text>
                    {describeViewAsShort(files.viewAs)} can't read this file.{' '}
                    {query.error.extras.line ? `Line ${query.error.extras.line} refused it.` : ''}
                  </Text>
                  <RefusalDetail
                    extras={query.error.extras}
                    trigger={
                      <Button variant="secondary" size="sm">
                        See why
                      </Button>
                    }
                  />
                </div>
              ) : (
                <Text variant="secondary">{query.error.message}</Text>
              )
            ) : object ? (
              <Preview
                key={`${object.name}:${object.generation}`}
                object={object}
                project={files.project}
                large
              />
            ) : (
              <div className="h-full animate-pulse rounded-md bg-kumo-tint" />
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
