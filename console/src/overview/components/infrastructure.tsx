// The listeners no section owns — the hub, this UI, the official logging
// feed and the Firestore requests socket — with their addresses, as the
// official port list has them: what a test harness or the Firebase CLI
// needs to find the emulators. One row of a definition list the "Not
// running" row shares.

import { Tooltip } from '@cloudflare/kumo'
import { CopyField } from '@/components/console/copy-button'
import type { InfrastructureEntry } from '../model'

export function Infrastructure({ entries }: { entries: readonly InfrastructureEntry[] }) {
  if (entries.length === 0) return null
  return (
    <>
      <dt className="pt-px text-[12px] leading-5 text-kumo-subtle">Infrastructure</dt>
      <dd
        className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1"
        data-testid="overview-infrastructure"
      >
        {entries.map((entry) => (
          <span
            key={entry.name}
            className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5"
            data-service={entry.name}
          >
            <Tooltip
              content={entry.about}
              render={<span className="shrink-0 text-kumo-subtle">{entry.label}</span>}
            />
            {entry.thisPage && <span className="shrink-0 text-kumo-subtle">(this page)</span>}
            <CopyField value={entry.address} className="text-kumo-default" />
          </span>
        ))}
      </dd>
    </>
  )
}
