// Resetting one section, or every section the console can reset, through
// the foundation's confirmation: what goes (the figures already on screen,
// no preview request), what it sets off, and the way back. The engine runs
// it as one suite job; the dialog closes once the job has started, the
// Reset card follows its progress and Cancel, and every tab hears how it
// ended. A Firestore reset runs no Functions triggers unless asked: it
// commits as maintenance, which listeners still see. Resetting more than
// one section asks for the project id.

import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import type { SectionStatus } from '@/api/generated/SectionStatus'
import { DangerConfirm } from '@/components/console/danger-confirm'
import type { ConsoleSection } from '@/lib/services'
import { startClear } from '../api'
import { resetConsequence } from '../model'
import { LINK_CLASS } from './text-link'

export type ResetTarget = { kind: 'section'; id: string } | { kind: 'everything' }

/** "Firestore (211,260 documents)", or the label alone without a summary. */
function withHeadline(section: ConsoleSection, status: SectionStatus): string {
  return status.summary?.headline ? `${section.label} (${status.summary.headline})` : section.label
}

/** "A", "A and B", "A, B and C". */
function listed(parts: readonly string[]): string {
  if (parts.length < 2) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

export function ResetDialog({
  open,
  onOpenChange,
  target,
  sections,
  status,
  snapshotting,
  onSnapshot,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: ResetTarget | undefined
  /** Every section the console can reset now, with its status. */
  sections: readonly { section: ConsoleSection; status: SectionStatus }[]
  status: ConsoleStatus
  /** A snapshot is being prepared: the way back is on its way. */
  snapshotting: boolean
  /** Starts a snapshot download of everything, the way back. */
  onSnapshot: () => void
}) {
  const client = useQueryClient()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [runTriggers, setRunTriggers] = useState(false)
  // Each opening is a fresh confirmation (nothing typed): the dialog closes
  // itself once the reset has started, not through its own Cancel.
  const [round, setRound] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setRound((count) => count + 1)
  }

  const named =
    target?.kind === 'section'
      ? sections.filter((entry) => entry.section.id === target.id)
      : sections
  const everything = target?.kind === 'everything'
  const only = named.length === 1 ? named[0] : undefined
  const firestore = only?.section.id === 'firestore'
  const functionsRun = status.services.some((service) => service.name === 'functions')

  const close = (next: boolean) => {
    if (!next) {
      setError(undefined)
      setRunTriggers(false)
    }
    onOpenChange(next)
  }

  const confirm = async () => {
    setPending(true)
    setError(undefined)
    try {
      await startClear(client, {
        sections: named.map((entry) => entry.section.id),
        ...(named.length > 1 || everything ? { confirm: status.projectId } : {}),
        ...(firestore && runTriggers ? { runTriggers: true } : {}),
      })
      setPending(false)
      close(false)
    } catch (thrown) {
      setPending(false)
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    }
  }

  const wayBack: ReactNode = (
    <>
      Download a snapshot first to get {firestore ? 'them' : 'it'} back.{' '}
      <button
        type="button"
        className={LINK_CLASS}
        onClick={onSnapshot}
        disabled={snapshotting}
        data-testid="reset-snapshot"
      >
        {snapshotting ? 'Preparing a snapshot…' : 'Download a snapshot'}
      </button>
    </>
  )

  const title = everything ? 'Reset everything' : only ? `Reset ${only.section.label}` : 'Reset'
  const description = everything
    ? `Deletes all data in ${listed(named.map((entry) => withHeadline(entry.section, entry.status)))}. Functions code, rules and configuration are untouched.`
    : firestore
      ? `Every document in every database is deleted${only?.status.summary ? `: ${only.status.summary.headline}` : ''}.`
      : only
        ? `Everything ${only.section.label} holds is deleted${only.status.summary ? `: ${only.status.summary.headline}` : ''}.`
        : ''

  const consequences: ReactNode[] = []
  if (firestore)
    consequences.push(
      runTriggers
        ? 'Functions triggers run for each deleted document.'
        : 'Functions triggers do not run for these deletions.',
      'Listeners and open pages see the documents go.',
    )
  else if (everything) consequences.push('Functions triggers do not run.')
  for (const entry of named) {
    const line = resetConsequence(entry.section.id)
    if (line) consequences.push(line)
  }
  consequences.push(wayBack)

  return (
    <DangerConfirm
      key={round}
      open={open && target !== undefined && named.length > 0}
      onOpenChange={close}
      title={title}
      description={description}
      consequences={consequences}
      {...(everything ? { confirmText: status.projectId } : {})}
      {...(firestore && functionsRun
        ? {
            option: {
              label: 'Run Functions triggers for deleted documents',
              checked: runTriggers,
              onChange: setRunTriggers,
            },
          }
        : {})}
      {...(error ? { error } : {})}
      pending={pending}
      onConfirm={() => void confirm()}
      testId="reset-dialog"
    />
  )
}
