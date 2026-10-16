import { Mark, Text } from '@firenook/kit'

/** The mark alone at three sizes, and the wordmark lockup used in the shell header. */
export function Sizes() {
  return (
    <div className="flex items-center gap-4">
      <Mark size={48} />
      <Mark size={28} />
      <Mark size={20} />
    </div>
  )
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <Mark />
      <span className="text-[20px] leading-none font-semibold text-kumo-strong">Firenook</span>
      <Text variant="secondary" size="lg">
        console
      </Text>
    </span>
  )
}
