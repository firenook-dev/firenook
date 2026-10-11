import { Meter } from '@firenook/kit'

/** A measured value within a known range, such as a buffer or a quota. */
export function Buffer() {
  return (
    <div className="grid w-80 gap-4">
      <Meter label="Requests buffer" value={182} max={256} showValue />
      <Meter label="Retained log records" value={1024} max={1024} showValue />
    </div>
  )
}
