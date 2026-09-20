import { SkeletonLine } from '@firenook/kit'

/** Placeholder lines while a first page loads. Widths vary so the block reads as text. */
export function Paragraph() {
  return (
    <div className="grid w-80 gap-2">
      <SkeletonLine className="w-3/4" />
      <SkeletonLine className="w-full" />
      <SkeletonLine className="w-5/6" />
      <SkeletonLine className="w-1/2" />
    </div>
  )
}
