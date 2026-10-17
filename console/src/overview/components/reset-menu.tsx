// "Reset data": which section's data to delete, each with what it holds
// now, and everything at the end, apart and in red. A section that holds
// nothing stays listed, dimmed, so the menu keeps its shape. Choosing one
// opens its confirmation; nothing is deleted from the menu itself.
//
// Kumo's `DropdownMenu` is not in the landing route's chunk, so this file
// loads after the Overview's first paint (`data-section.tsx` draws the same
// button until it has).

import { DropdownMenu } from '@cloudflare/kumo'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react'
import type { SectionStatus } from '@/api/generated/SectionStatus'
import type { ConsoleSection } from '@/lib/services'
import { holdsNothing } from '../model'
import type { ResetTarget } from './reset-dialog'
import { ResetButton } from './reset-button'

export function ResetMenu({
  sections,
  busy,
  onReset,
}: {
  /** Every section the console can reset now, with its status. */
  sections: readonly { section: ConsoleSection; status: SectionStatus }[]
  /** Why nothing can start now: a data job is running. */
  busy: string | undefined
  onReset: (target: ResetTarget) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<ResetButton disabled={busy !== undefined} title={busy} />} />
      <DropdownMenu.Content align="start" className="min-w-72" data-testid="overview-reset-menu">
        {sections.map(({ section, status }) => {
          const empty = holdsNothing(status.summary)
          return (
            <DropdownMenu.Item
              key={section.id}
              icon={section.icon}
              disabled={empty}
              onClick={() => onReset({ kind: 'section', id: section.id })}
              className="items-start"
              data-testid={`overview-reset-${section.id}`}
            >
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span>{section.label}</span>
                <span className="truncate font-mono text-[12px] text-kumo-subtle">
                  {empty ? 'Empty' : (status.summary?.headline ?? '')}
                </span>
              </span>
            </DropdownMenu.Item>
          )
        })}
        {sections.length > 1 && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              icon={ArrowCounterClockwiseIcon}
              variant="danger"
              onClick={() => onReset({ kind: 'everything' })}
              data-testid="overview-reset-everything"
            >
              Everything…
            </DropdownMenu.Item>
          </>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
