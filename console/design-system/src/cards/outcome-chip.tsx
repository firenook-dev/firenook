// The outcome chip every section shares (compute's isolated commit 10a,
// built by the foundation so every stream has it from G2): every
// invocation outcome of compute's §5.0 table, and the plain word-and-tone
// form Cloud Tasks, Pub/Sub and Authentication pass.

import { Text } from '@cloudflare/kumo'
import type { ReactNode } from 'react'
import {
  type InvocationOutcome,
  type OutcomeClass,
  OutcomeChip,
} from '@/components/console/outcome-chip'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

const INVOCATIONS: Array<{
  outcome: InvocationOutcome
  outcomeClass: OutcomeClass
  status?: number
  callableStatus?: string
  note: string
}> = [
  { outcome: 'succeeded', outcomeClass: 'succeeded', note: 'a background function returned' },
  {
    outcome: 'succeeded',
    outcomeClass: 'succeeded',
    status: 200,
    note: 'a URL invocation, its status',
  },
  { outcome: 'allowed', outcomeClass: 'succeeded', note: 'a blocking function let the user in' },
  {
    outcome: 'blocked',
    outcomeClass: 'succeeded',
    note: 'a blocking function refused: it did its job',
  },
  { outcome: 'clientError', outcomeClass: 'failed', status: 404, note: '4xx' },
  {
    outcome: 'callableError',
    outcomeClass: 'failed',
    callableStatus: 'INVALID_ARGUMENT',
    note: 'a callable, a client error code',
  },
  {
    outcome: 'callableError',
    outcomeClass: 'failed',
    callableStatus: 'INTERNAL',
    note: 'a callable, a server error code',
  },
  { outcome: 'failed', outcomeClass: 'failed', note: 'a background handler threw' },
  { outcome: 'failed', outcomeClass: 'failed', status: 500, note: '5xx' },
  { outcome: 'timedOut', outcomeClass: 'failed', note: 'past its timeout' },
  { outcome: 'crashed', outcomeClass: 'failed', note: 'the worker died' },
  { outcome: 'notStarted', outcomeClass: 'failed', note: 'the code did not load' },
  { outcome: 'paused', outcomeClass: 'skipped', note: 'background triggers were paused' },
  { outcome: 'removed', outcomeClass: 'skipped', note: 'the function left in a reload' },
]

function Row({ chip, note }: { chip: ReactNode; note: string }) {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] items-center gap-4 border-b border-kumo-hairline py-1.5 last:border-b-0">
      <span className="flex min-w-0 items-center gap-2">{chip}</span>
      <Text variant="secondary" size="sm">
        {note}
      </Text>
    </div>
  )
}

/** A running invocation counts up from when it started: a few seconds before the card loads. */
const STARTED = new Date(Date.now() - 3_400).toISOString()

function OutcomeChipsCard() {
  return (
    <Stack>
      <Section
        title="Invocations"
        note="The engine computes the outcome and its class; colour only where it means something, data in the data face."
      >
        <div className="grid rounded-lg bg-kumo-base px-4 py-1 ring ring-kumo-line">
          {INVOCATIONS.map((item) => (
            <Row
              key={`${item.outcome}-${item.status ?? ''}-${item.callableStatus ?? ''}`}
              chip={
                <OutcomeChip
                  outcome={item.outcome}
                  outcomeClass={item.outcomeClass}
                  status={item.status}
                  callableStatus={item.callableStatus}
                />
              }
              note={item.note}
            />
          ))}
          <Row
            chip={<OutcomeChip outcome={null} outcomeClass="running" startedAt={STARTED} />}
            note="still running: the elapsed time, a breathing dot"
          />
        </div>
      </Section>
      <Section
        title="Other sections' outcomes"
        note="Their own word in a shared tone: Pub/Sub deliveries, Cloud Tasks attempts, Authentication's activity."
      >
        <div className="grid rounded-lg bg-kumo-base px-4 py-1 ring ring-kumo-line">
          <Row chip={<OutcomeChip word="delivered" tone="success" />} note="Pub/Sub delivery" />
          <Row
            chip={<OutcomeChip word="running" tone="brand" pulse />}
            note="Pub/Sub delivery under way"
          />
          <Row
            chip={<OutcomeChip word="queued" tone="neutral" />}
            note="waiting for the delivery queue"
          />
          <Row
            chip={
              <OutcomeChip
                word="skipped"
                tone="neutral"
                detail="Background triggers were paused, so the event was dropped, not queued."
              />
            }
            note="the reason is in the tooltip"
          />
          <Row chip={<OutcomeChip word="204" tone="success" mono />} note="Cloud Tasks attempt" />
          <Row
            chip={<OutcomeChip word="503" tone="danger" mono />}
            note="Cloud Tasks attempt that failed"
          />
          <Row chip={<OutcomeChip word="ok" tone="success" mono />} note="an Auth call" />
          <Row
            chip={<OutcomeChip word="auth/user-not-found" tone="danger" mono />}
            note="an Auth call's error code"
          />
        </div>
      </Section>
    </Stack>
  )
}

defineCards([
  {
    id: 'outcome-chips',
    group: 'Components',
    name: 'Outcome chips',
    subtitle:
      'Every invocation outcome of the compute table and the plain word-and-tone form other sections use',
    width: 720,
    surface: 'canvas',
    render: () => <OutcomeChipsCard />,
  },
  {
    id: 'outcome-chips-dark',
    group: 'Components',
    name: 'Outcome chips, dark',
    subtitle: 'The same, in dark mode',
    width: 720,
    dark: true,
    surface: 'canvas',
    render: () => <OutcomeChipsCard />,
  },
])
