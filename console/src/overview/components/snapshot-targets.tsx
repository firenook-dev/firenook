// The "What" of a snapshot: one checkbox per service the engine runs whose
// data a snapshot holds (Firestore, Authentication, Storage), each with the
// figures its section already shows. Shared by the download and the save
// dialogs.

import { Checkbox } from '@cloudflare/kumo'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { serviceLabel } from '@/lib/services'
import { SNAPSHOT_SERVICES } from '../snapshot'

/** The snapshot services this engine runs, in the console's order. */
export function snapshotServices(status: ConsoleStatus): string[] {
  return SNAPSHOT_SERVICES.filter((name) =>
    status.services.some((service) => service.name === name),
  )
}

/** "Firestore, Authentication and Storage". */
export function listedLabels(names: readonly string[]): string {
  const labels = names.map(serviceLabel)
  if (labels.length < 2) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
}

export function SnapshotTargets({
  status,
  services,
  checked,
  onChange,
  disabled,
  testId,
}: {
  status: ConsoleStatus
  services: readonly string[]
  checked: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  disabled?: boolean | undefined
  testId: string
}) {
  return (
    <fieldset className="grid gap-2" data-testid={testId}>
      <legend className="mb-1 text-[13px] font-medium text-kumo-default">What</legend>
      {services.map((name) => {
        const headline = status.sections.find((entry) => entry.id === name)?.summary?.headline
        return (
          <Checkbox
            key={name}
            checked={checked.has(name)}
            disabled={disabled === true}
            onCheckedChange={(on) => {
              const next = new Set(checked)
              if (on) next.add(name)
              else next.delete(name)
              onChange(next)
            }}
            label={
              <span className="flex min-w-0 items-baseline gap-3">
                <span className="w-28 shrink-0 text-[14px]">{serviceLabel(name)}</span>
                {headline && (
                  <span className="truncate font-mono text-[12px] text-kumo-subtle">
                    {headline}
                  </span>
                )}
              </span>
            }
            data-testid={`${testId}-${name}`}
          />
        )
      })}
    </fieldset>
  )
}
