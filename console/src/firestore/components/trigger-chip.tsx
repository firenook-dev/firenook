// Which functions run on this document: a quiet lightning chip with the
// count beside the document's size and age, and a popover that names each
// function and the changes it fires on ("onOrderCreated — create",
// "onOrderWritten — every write"), each a link to it in Functions.
//
// The answer is the engine's own matcher (`useTriggersFor`, `GET
// /functions/triggers`), asked once per document and kept, so reopening a
// document asks nothing; a codebase reload refreshes it. While Functions are
// absent, starting or not built, or nothing listens, there is no chip.

import { Button, Popover } from '@cloudflare/kumo'
import { LightningIcon } from '@phosphor-icons/react'
import { EntityLink } from '@/components/console/entity-link'
import { PanelTitle } from '@/components/kit'
import { formatNumber } from '@/lib/format'
import { type TriggerFunction, useTriggersFor } from '@/lib/triggers'

/**
 * The changes a Firestore trigger fires on, from its event type in either
 * generation: `document.create` and `document.v1.created` both fire on a
 * create, `document.write` and `document.v1.written` on every write.
 */
export function firestoreChange(eventType: string): string {
  const type = eventType.replace(/\.withAuthContext$/, '')
  const tail = type.slice(type.lastIndexOf('.') + 1)
  if (tail === 'create' || tail === 'created') return 'create'
  if (tail === 'update' || tail === 'updated') return 'update'
  if (tail === 'delete' || tail === 'deleted') return 'delete'
  if (tail === 'write' || tail === 'written') return 'every write'
  return tail
}

/** `us-central1-onOrderCreated` reads as the export the developer wrote. */
function exportName(functionId: string): string {
  return functionId.replace(/^[a-z]+-[a-z]+\d+-/, '')
}

export function TriggerChip({ database, path }: { database: string; path: string }) {
  const answer = useTriggersFor('firestore', `${database}|${path}`)
  if (answer === 'unknown' || answer === 'absent' || answer.functions.length === 0) return null
  const functions = answer.functions
  const count = functions.length
  const label = `${formatNumber(count)} function${count === 1 ? '' : 's'} run${count === 1 ? 's' : ''} on this document`
  return (
    <Popover>
      <Popover.Trigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="h-5 gap-0.5 px-1 text-xs font-normal text-kumo-subtle tabular-nums"
            aria-label={label}
            data-testid="document-triggers"
          >
            <LightningIcon size={12} aria-hidden />
            {formatNumber(count)}
          </Button>
        }
      />
      <Popover.Content className="grid w-[360px] max-w-[calc(100vw-2rem)] gap-2">
        {/* Kumo's popover passes no test id on; its contents carry it. */}
        <div className="contents" data-testid="document-triggers-list">
          <PanelTitle>Functions that run on this document</PanelTitle>
          <ul className="grid gap-1">
            {functions.map((fn) => (
              <TriggerRow key={`${fn.codebase}|${fn.functionId}|${fn.eventType}`} fn={fn} />
            ))}
          </ul>
          {!answer.backgroundEnabled && (
            <p className="m-0 text-[12px] text-kumo-subtle" data-testid="document-triggers-paused">
              Background triggers are paused, so none of them runs until they are resumed.
            </p>
          )}
        </div>
      </Popover.Content>
    </Popover>
  )
}

function TriggerRow({ fn }: { fn: TriggerFunction }) {
  const entity = fn.function ?? { kind: 'functions.function', key: fn.functionId }
  return (
    <li className="min-w-0 text-[12px] leading-5" data-testid="document-trigger">
      <EntityLink entity={{ ...entity, label: exportName(fn.functionId) }} />{' '}
      <span className="text-kumo-subtle">— {firestoreChange(fn.eventType)}</span>
    </li>
  )
}
