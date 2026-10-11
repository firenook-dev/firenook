import { Switch } from '@firenook/kit'

/** The console uses the neutral variant so switches match the checkbox; the accent stays reserved for primary actions. */
export function Neutral() {
  return (
    <div className="grid gap-3">
      <Switch variant="neutral" label="Live updates" checked onCheckedChange={() => {}} />
      <Switch
        variant="neutral"
        label="Show missing documents"
        checked={false}
        onCheckedChange={() => {}}
      />
      <Switch variant="neutral" label="Compact rows" size="sm" checked onCheckedChange={() => {}} />
      <Switch
        variant="neutral"
        label="Disabled"
        disabled
        checked={false}
        onCheckedChange={() => {}}
      />
    </div>
  )
}
