// What happened to this file, newest first: its changes — who made them
// (an Auth user links to Authentication), whether from the console or the
// app, and whether the event went to the Functions emulator — and the rules
// decisions on its name, arriving live while the tab is open. Each list says
// the window it comes from; a file older than that window closes the list
// with its own created and updated times, greyed. Below, the exact event
// bodies the file sends, and the way to send one again.

import { Tooltip } from '@cloudflare/kumo'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { StorageDecision } from '@/api/generated/storage/StorageDecision'
import type { StorageEventDelivery } from '@/api/generated/storage/StorageEventDelivery'
import type { StorageObjectChange } from '@/api/generated/storage/StorageObjectChange'
import type { StorageObjectDetail } from '@/api/generated/storage/StorageObjectDetail'
import { EntityLink } from '@/components/console/entity-link'
import { InspectorSection } from '@/components/console/inspector'
import { exactTime } from '@/components/console/relative-time'
import { useNow } from '@/lib/clock'
import { clockTime, formatBytes, formatClock, useClockFormat } from '@/lib/format'
import { useTriggersFor } from '@/lib/triggers'
import { Verdict } from '@/rules/verdict'
import { useStorageDecisionsLive } from '../../live'
import { activityQuery, rulesScope } from '../../queries'
import { useFiles } from '../../files-state'
import { useRulesPageLink } from '../../rules-link'
import { EventPayloads } from './event-payloads'

type Entry =
  | { kind: 'change'; at: string; change: StorageObjectChange }
  | { kind: 'decision'; at: string; decision: StorageDecision }

/** Changes and decisions in one list, newest first; a decision seen twice is listed once. */
export function activityEntries(
  changes: readonly StorageObjectChange[],
  decisions: readonly StorageDecision[],
): Entry[] {
  const seen = new Set<string>()
  const unique = decisions.filter((decision) => {
    if (seen.has(decision.id)) return false
    seen.add(decision.id)
    return true
  })
  return [
    ...changes.map((change): Entry => ({ kind: 'change', at: change.at, change })),
    ...unique.map((decision): Entry => ({ kind: 'decision', at: decision.at, decision })),
  ].toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

const CHANGE_WORDS: Record<StorageObjectChange['kind'], string> = {
  created: 'created',
  replaced: 'replaced',
  metadata: 'metadata',
  tokens: 'tokens',
  deleted: 'deleted',
}

/** What became of the event a change made, said only when there is something to say. */
export function deliveryText(delivery: StorageEventDelivery): string | undefined {
  switch (delivery) {
    case 'sent':
      return 'Sent to the Functions emulator'
    case 'pending':
      return 'Being sent to the Functions emulator'
    case 'paused':
      return 'Background triggers are paused'
    case 'failed':
      return 'Not sent: the delivery runtime was stopping'
    case 'no-functions':
    case 'no-event':
      return undefined
  }
}

function Who({
  uid,
  tenant,
  admin,
  console: fromConsole,
}: {
  uid: string | null
  tenant: string | null
  admin: boolean
  console: boolean
}) {
  const where = fromConsole ? 'console' : 'your app'
  if (uid)
    return (
      <span className="flex min-w-0 items-center gap-1">
        <EntityLink entity={{ kind: 'auth.user', key: `${tenant ?? ''}|${uid}`, label: uid }} />
        <span className="shrink-0 text-[11px] text-kumo-subtle">· from {where}</span>
      </span>
    )
  return (
    <span className="truncate text-[12px] text-kumo-subtle">
      {admin ? 'Admin' : 'Anonymous'} · {fromConsole ? 'console' : 'app'}
    </span>
  )
}

function Time({ iso }: { iso: string }) {
  const { format } = useClockFormat()
  const now = useNow('second')
  return (
    <Tooltip
      content={exactTime(iso)}
      render={
        <time
          dateTime={iso}
          className="shrink-0 cursor-default font-mono text-[11px] text-kumo-subtle tabular-nums"
        >
          {formatClock(iso, format, now)}
        </time>
      }
    />
  )
}

function ChangeRow({ change, functions }: { change: StorageObjectChange; functions: string[] }) {
  const detail =
    change.kind === 'metadata' || change.kind === 'tokens'
      ? change.metadataKeys.join(', ')
      : change.kind === 'deleted'
        ? ''
        : formatBytes(change.size)
  const delivery = deliveryText(change.delivery)
  return (
    <li
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 py-1"
      data-testid="activity-change"
      data-kind={change.kind}
    >
      <span
        className={`mt-1.5 size-1.5 rounded-full ${
          change.kind === 'deleted'
            ? 'bg-kumo-danger'
            : change.kind === 'created'
              ? 'bg-kumo-success'
              : 'bg-kumo-interact'
        }`}
        aria-hidden
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[12px] text-kumo-default">
            {CHANGE_WORDS[change.kind]}
          </span>
          {detail && (
            <span className="truncate font-mono text-[11px] text-kumo-subtle">{detail}</span>
          )}
        </span>
        <Who
          uid={change.actor.uid}
          tenant={change.actor.tenant}
          admin={change.actor.kind === 'admin' || change.actor.kind === 'system'}
          console={change.actor.viaConsole}
        />
        {delivery && (
          <span className="text-[11px] text-kumo-subtle" data-testid="activity-delivery">
            {delivery}
            {change.delivery === 'sent' && functions.length > 0 && (
              <>
                {' → '}
                {functions.map((id, index) => (
                  <span key={id}>
                    {index > 0 && ', '}
                    <EntityLink
                      entity={{
                        kind: 'functions.function',
                        key: id,
                        label: id.replace(/^[a-z]+-[a-z]+\d+-/, ''),
                      }}
                    />
                  </span>
                ))}
              </>
            )}
          </span>
        )}
      </span>
      <Time iso={change.at} />
    </li>
  )
}

function DecisionRow({
  decision,
  onSeeWhy,
}: {
  decision: StorageDecision
  onSeeWhy: ((decision: StorageDecision) => void) | undefined
}) {
  const line = decision.allows.find((allow) =>
    decision.outcome === 'allow' ? allow.outcome === 'allow' : allow.outcome !== 'allow',
  )?.line
  return (
    <li
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 py-1"
      data-testid="activity-decision"
      data-outcome={decision.outcome}
    >
      <span className="mt-0.5 flex">
        <Verdict outcome={decision.outcome} />
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-mono text-[12px] text-kumo-default">{decision.method}</span>
          {line !== undefined && <span className="text-[11px] text-kumo-subtle">line {line}</span>}
          {decision.outcome !== 'allow' && onSeeWhy && (
            <button
              type="button"
              className="rounded-sm text-[11px] text-kumo-link hover:underline focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
              onClick={() => onSeeWhy(decision)}
              data-testid="activity-see-why"
            >
              See why
            </button>
          )}
        </span>
        <Who
          uid={decision.uid}
          tenant={decision.tenant}
          admin={false}
          console={decision.viaConsole}
        />
      </span>
      <Time iso={decision.at} />
    </li>
  )
}

export function ActivityTab({ object }: { object: StorageObjectDetail }) {
  const files = useFiles()
  const activity = useQuery(activityQuery(files.project, object.bucket, object.name))
  const [live, setLive] = useState<{ name: string; items: StorageDecision[] }>({
    name: object.name,
    items: [],
  })
  const arrived = live.name === object.name ? live.items : []
  const diagnostics = activity.data?.diagnostics ?? false
  useStorageDecisionsLive(
    files.project,
    rulesScope(files.buckets, object.bucket),
    diagnostics ? { bucket: object.bucket, path: object.name } : null,
    {
      onDecisions: (batch) =>
        setLive((current) => ({
          name: object.name,
          items: [...batch.items, ...(current.name === object.name ? current.items : [])].slice(
            0,
            500,
          ),
        })),
    },
  )
  const triggers = useTriggersFor('storage', `${object.bucket}|${object.name}`)
  const functions =
    triggers === 'unknown' || triggers === 'absent'
      ? []
      : triggers.functions
          .filter(
            (fn) => /finalized|finalize/i.test(fn.eventType) || /metadata/i.test(fn.eventType),
          )
          .map((fn) => fn.functionId)
  const rules = useRulesPageLink()
  if (activity.isError)
    return <p className="px-5 py-3 text-[13px] text-kumo-danger">{activity.error.message}</p>
  if (!activity.data)
    return <div className="mx-5 my-3 h-32 animate-pulse rounded-md bg-kumo-tint" />
  const entries = activityEntries(activity.data.changes, [...arrived, ...activity.data.decisions])
  const since = activity.data.changesSince
  const older = since !== null && Date.parse(object.timeCreated) < Date.parse(since)
  return (
    <div data-testid="activity-tab">
      <InspectorSection title="Activity" count={entries.length} testId="activity">
        {entries.length > 0 && (
          <ul className="grid">
            {entries.map((entry) =>
              entry.kind === 'change' ? (
                <ChangeRow
                  key={`c${entry.change.revision}`}
                  change={entry.change}
                  functions={functions}
                />
              ) : (
                <DecisionRow
                  key={`d${entry.decision.id}`}
                  decision={entry.decision}
                  onSeeWhy={
                    rules
                      ? (decision) => {
                          const line = decision.allows.find(
                            (allow) => allow.outcome !== 'allow',
                          )?.line
                          rules({
                            ...(files.buckets.rulesMode === 'perBucket'
                              ? { bucket: object.bucket }
                              : {}),
                            panel: 'decisions',
                            decision: decision.id,
                            ...(line ? { line } : {}),
                          })
                        }
                      : undefined
                  }
                />
              ),
            )}
          </ul>
        )}
        {older && (
          <ul className="grid opacity-60" data-testid="activity-before-window">
            <li className="flex items-baseline justify-between gap-2 py-1 text-[12px] text-kumo-subtle">
              <span>
                created {formatClock(object.timeCreated, 'utc').slice(0, 19).replace('T', ' ')} ·
                updated {formatClock(object.updated, 'utc').slice(0, 19).replace('T', ' ')}
              </span>
              <span className="shrink-0 text-[11px]">before this window</span>
            </li>
          </ul>
        )}
        <p className="mt-1 text-[11px] text-kumo-subtle" data-testid="activity-windows">
          {since
            ? `Since ${clockTime(since, 'second')} (changes)`
            : 'Every change since the engine started'}
          {' · '}
          {!diagnostics
            ? 'Rules decisions are off: the suite was started with --no-diagnostics.'
            : activity.data.decisionsSince
              ? `since ${clockTime(activity.data.decisionsSince, 'second')} (decisions)`
              : 'no rules decision on this name yet'}
        </p>
      </InspectorSection>
      <EventPayloads object={object} project={files.project} admin={files.admin} />
    </div>
  )
}
