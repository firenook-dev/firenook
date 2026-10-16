import { Surface, Text } from '@firenook/kit'

/** Flat surfaces sit on the canvas with a hairline; raised ones carry a shadow. */
export function Variants() {
  return (
    <div className="flex flex-wrap gap-4 rounded-lg bg-kumo-canvas p-4">
      <Surface variant="flat" className="w-56 p-4">
        <Text bold>Flat</Text>
        <Text variant="secondary">A panel that belongs to the page.</Text>
      </Surface>
      <Surface variant="raised" className="w-56 p-4">
        <Text bold>Raised</Text>
        <Text variant="secondary">A panel that sits above it.</Text>
      </Surface>
    </div>
  )
}
