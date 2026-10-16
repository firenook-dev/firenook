// A PDF in the browser's own viewer, from the console's media route (the
// one type served without the sandbox, which the viewer refuses).

import { Button, cn } from '@cloudflare/kumo'
import { ArrowSquareOutIcon } from '@phosphor-icons/react'
import { usePreviewSlot } from './use-slot'

export function PreviewPdf({ url, large = false }: { url: string; large?: boolean }) {
  const { src, done } = usePreviewSlot(url)
  return (
    <div className={cn('grid gap-1.5', large && 'h-full grid-rows-[minmax(0,1fr)_auto]')}>
      {src && (
        // A PDF is the one type the media route serves without its sandbox:
        // the browser's viewer refuses to run in a sandboxed frame.
        // oxlint-disable-next-line react/iframe-missing-sandbox -- see above
        <iframe
          src={src}
          title="PDF preview"
          className={cn(
            'w-full rounded-md bg-kumo-base ring ring-kumo-line',
            large ? 'h-full' : 'h-[480px]',
          )}
          onLoad={done}
          data-testid="preview-pdf"
        />
      )}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="xs"
          icon={<ArrowSquareOutIcon />}
          onClick={() => window.open(url, '_blank', 'noopener')}
        >
          Open in a new tab
        </Button>
      </div>
    </div>
  )
}
