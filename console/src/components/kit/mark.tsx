import { CampfireIcon } from '@phosphor-icons/react'

/**
 * The Firenook mark: the ember square with the campfire glyph. Sits beside
 * the wordmark in the shell header and stands alone as the favicon-sized mark.
 * @category Brand
 */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <CampfireIcon size={Math.round(size * 0.58)} weight="bold" />
    </span>
  )
}
