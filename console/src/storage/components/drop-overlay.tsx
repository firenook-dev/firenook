// Where a drag of files will land, said over the content while it is held:
// the folder in view, or the folder row or tile under the pointer, which
// lights up. Opaque enough to read on any listing.

import { UploadSimpleIcon } from '@phosphor-icons/react'

export function DropOverlay({ target, summary }: { target: string; summary: string | undefined }) {
  return (
    <div
      className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-firenook-flame bg-kumo-base/85"
      data-testid="drop-overlay"
    >
      <div className="grid justify-items-center gap-1.5 text-center">
        <UploadSimpleIcon size={28} className="text-firenook-flame" />
        <span className="text-[14px] text-kumo-default">Drop to upload into</span>
        <span className="font-mono text-[13px] text-kumo-default" data-testid="drop-target">
          {target}
        </span>
        {summary && <span className="text-[12px] text-kumo-subtle">{summary}</span>}
      </div>
    </div>
  )
}
