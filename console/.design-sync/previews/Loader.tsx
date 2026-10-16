import { Loader, Text } from '@firenook/kit'

/** Three sizes. Only for work that has not produced data yet; never over data already on screen. */
export function Sizes() {
  return (
    <div className="flex items-center gap-6">
      <span className="flex items-center gap-2">
        <Loader size="sm" />
        <Text size="sm">sm</Text>
      </span>
      <span className="flex items-center gap-2">
        <Loader />
        <Text size="sm">base</Text>
      </span>
      <span className="flex items-center gap-2">
        <Loader size="lg" />
        <Text size="sm">lg</Text>
      </span>
    </div>
  )
}
