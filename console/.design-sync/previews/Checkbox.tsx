import { Checkbox } from '@firenook/kit'

/** Checked, unchecked and indeterminate; the checked fill is the contrast surface, not the accent. */
export function States() {
  return (
    <div className="grid gap-3">
      <Checkbox label="Email verified" checked onCheckedChange={() => {}} />
      <Checkbox label="Disabled account" checked={false} onCheckedChange={() => {}} />
      <Checkbox
        label="Some rows selected"
        indeterminate
        checked={false}
        onCheckedChange={() => {}}
      />
      <Checkbox label="Not available" disabled checked={false} onCheckedChange={() => {}} />
    </div>
  )
}
