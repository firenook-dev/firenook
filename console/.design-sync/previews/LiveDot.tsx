import { LiveDot } from '@firenook/kit'

/** live means the console channel is connected and the view updates without polling. */
export function States() {
  return (
    <div className="flex flex-wrap items-center gap-6">
      <LiveDot />
      <LiveDot changes={12} />
      <LiveDot state="reconnecting" />
      <LiveDot state="offline" />
    </div>
  )
}
