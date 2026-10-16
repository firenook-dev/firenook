import { Label } from '@firenook/kit'

export function WithTooltip() {
  return (
    <div className="grid gap-2">
      <Label>Collection id</Label>
      <Label required>Email</Label>
      <Label tooltip="Claims are copied into every ID token">Custom claims</Label>
    </div>
  )
}
