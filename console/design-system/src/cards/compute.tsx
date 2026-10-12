// Compute's own pieces (Functions, Extensions, Eventarc): the kind chip on
// white and zebra rows, durations and the timing bar, and an invocation's
// and a codebase's lines on observe's shared `LogLine`.

import { Text } from '@cloudflare/kumo'
import { type CSSProperties, type ReactNode, useState } from 'react'
import type { FunctionLogLine } from '@/api/generated/compute/FunctionLogLine'
import { DurationText } from '@/compute/duration-text'
import { KIND_WORDS, KindBadge } from '@/compute/kind-badge'
import { LogLines, lineKey } from '@/functions/components/log-lines'
import { TimingBar } from '@/functions/components/timing-bar'
import { createFeedStore } from '@/lib/live/feed-store'
import { defineCards } from '../registry'
import { Row, Section, Stack } from './shared'

function Box({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line" style={style}>
      {children}
    </div>
  )
}

// ── Kind chips ────────────────────────────────────────────────────────────

function KindRow({ zebra, label }: { zebra: boolean; label: string }) {
  return (
    <div
      className={`group flex flex-wrap items-center gap-1.5 border-b border-kumo-hairline px-3 py-2 last:border-b-0 ${
        zebra ? 'bg-kumo-elevated' : 'bg-kumo-base'
      }`}
    >
      <span className="w-24 shrink-0 text-[12px] text-kumo-subtle">{label}</span>
      {KIND_WORDS.map((kind) => (
        <KindBadge key={kind} kind={kind} />
      ))}
    </div>
  )
}

function KindBadgesCard() {
  return (
    <Stack>
      <Section
        title="Kind chips"
        note="The functions shell's word for how a function runs, in the data face, one quiet ground for every kind: the word names it, so no colour is spent on it."
      >
        <Box>
          <KindRow zebra={false} label="White row" />
          <KindRow zebra label="Zebra row" />
        </Box>
      </Section>
    </Stack>
  )
}

// ── Durations and timing ─────────────────────────────────────────────────

const DURATIONS: Array<{ ms: number | null; cold?: boolean; worker?: number; note: string }> = [
  { ms: 0.4, note: 'under a millisecond' },
  { ms: 2.6, note: 'a warm HTTP call' },
  { ms: 840, note: 'under a second' },
  { ms: 1_240, note: 'seconds, one decimal' },
  { ms: 62_000, note: 'over a minute' },
  { ms: 820, cold: true, worker: 812, note: 'a cold start: the worker time is in the tooltip' },
  { ms: null, note: 'still running' },
]

const TIMINGS: Array<{
  label: string
  worker: number | null
  firstByte: number | null
  total: number | null
  running?: boolean
}> = [
  { label: 'Warm call', worker: null, firstByte: 7.9, total: 8.1 },
  { label: 'Cold start', worker: 812, firstByte: 819.9, total: 820.1 },
  { label: 'Streaming', worker: null, firstByte: 12, total: 1_520 },
  { label: 'Background', worker: null, firstByte: 6, total: 6 },
  { label: 'Timed out', worker: 410, firstByte: null, total: 60_410 },
  { label: 'Running', worker: null, firstByte: 40, total: null, running: true },
]

function DurationTimingCard() {
  return (
    <Stack>
      <Section
        title="Durations"
        note="The console's durations at 11 px in the data face; cold only when the call started its worker."
      >
        <Box>
          {DURATIONS.map((item) => (
            <div
              key={item.note}
              className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-4 border-b border-kumo-hairline px-4 py-1.5 last:border-b-0"
            >
              <DurationText ms={item.ms} cold={item.cold} workerStartMs={item.worker} />
              <Text variant="secondary" size="sm">
                {item.note}
              </Text>
            </div>
          ))}
        </Box>
      </Section>
      <Section
        title="Timing bar"
        note="Worker start (hatched), the wait for the first byte, the body: every point measured from the start, so the segments add up to the whole."
      >
        <div className="grid gap-4">
          {TIMINGS.map((item) => (
            <Row key={item.label} label={item.label}>
              <TimingBar
                className="w-full"
                running={item.running}
                timings={{
                  workerStartMs: item.worker,
                  firstByteMs: item.firstByte,
                  totalMs: item.total,
                }}
              />
            </Row>
          ))}
        </div>
      </Section>
    </Stack>
  )
}

// ── Log lines ─────────────────────────────────────────────────────────────

const at = (seconds: number) =>
  new Date(Date.parse('2026-10-12T06:09:09.000Z') + seconds * 1000).toISOString()

const line = (index: number, values: Partial<FunctionLogLine>): FunctionLogLine => ({
  index,
  at: at(index * 0.004),
  offsetMs: index * 4,
  level: 'info',
  message: '',
  kind: null,
  fields: null,
  afterFinish: false,
  ...values,
})

const INVOCATION: FunctionLogLine[] = [
  line(0, { message: 'checkout started for cart c_19', offsetMs: 0.3 }),
  line(1, { level: 'debug', message: 'cache miss for cart c_19', offsetMs: 1.2 }),
  line(2, {
    message: 'order placed',
    offsetMs: 12,
    fields: { orderId: 'o_123', total: 42.5, items: [{ sku: 'mug', qty: 2 }] },
  }),
  line(3, { level: 'warn', message: 'stock is low for mug (2 left)', offsetMs: 14 }),
  line(4, {
    level: 'error',
    kind: 'function.error',
    offsetMs: 18,
    message:
      "TypeError: Cannot read properties of undefined (reading 'email')\n    at sendReceipt (functions/index.js:41:18)\n    at checkout (functions/index.js:22:5)",
  }),
  line(5, { message: 'receipt queued after the answer', offsetMs: 1_240, afterFinish: true }),
]

const LOAD_LOG: FunctionLogLine[] = [
  line(0, { message: 'Loaded environment variables from .env, .env.demo-x.', offsetMs: 0 }),
  line(1, { message: 'compute fixture loaded', offsetMs: 0 }),
  line(2, {
    level: 'warn',
    offsetMs: 0,
    message:
      '{"level":40,"msg":"pino line from a logger stream"}\n{"level":30,"msg":"second line"}',
  }),
]

function Lines({
  lines,
  mode,
  open,
}: {
  lines: readonly FunctionLogLine[]
  mode: 'invocation' | 'codebase'
  open?: boolean
}) {
  const [store] = useState(() => {
    const created = createFeedStore<FunctionLogLine>({ max: 1_000, key: lineKey })
    created.push(lines)
    return created
  })
  return (
    <Box>
      <LogLines
        ariaLabel={mode === 'invocation' ? 'Logs of #1,284' : 'Load log of app'}
        store={store}
        mode={mode}
        running={open}
        defaultOpen={mode === 'invocation' ? ['2'] : undefined}
      />
    </Box>
  )
}

function FunctionLogLinesCard() {
  return (
    <Stack>
      <Section
        title="An invocation's lines"
        note="Offsets from its start, every message whole; a structured entry's fields open under it ({}); lines printed after it returned sit under the divider, quieter; a running one ends in a breathing dot."
      >
        <Lines lines={INVOCATION} mode="invocation" open />
      </Section>
      <Section
        title="A codebase's load log"
        note="The console's clock, one line each; a cut message opens in place."
      >
        <Lines lines={LOAD_LOG} mode="codebase" />
      </Section>
    </Stack>
  )
}

defineCards([
  {
    id: 'kind-badges',
    group: 'Components',
    name: 'Kind chips',
    subtitle: 'The thirteen kind words on white and zebra rows',
    width: 880,
    surface: 'canvas',
    render: () => <KindBadgesCard />,
  },
  {
    id: 'kind-badges-dark',
    group: 'Components',
    name: 'Kind chips, dark',
    subtitle: 'The same, in dark mode',
    width: 880,
    dark: true,
    surface: 'canvas',
    render: () => <KindBadgesCard />,
  },
  {
    id: 'duration-timing',
    group: 'Components',
    name: 'Durations and timing',
    subtitle: 'DurationText boundaries and the timing bar with and without a cold start',
    width: 720,
    surface: 'canvas',
    render: () => <DurationTimingCard />,
  },
  {
    id: 'duration-timing-dark',
    group: 'Components',
    name: 'Durations and timing, dark',
    subtitle: 'The same, in dark mode',
    width: 720,
    dark: true,
    surface: 'canvas',
    render: () => <DurationTimingCard />,
  },
  {
    id: 'function-log-lines',
    group: 'Patterns',
    name: 'Function log lines',
    subtitle:
      "An invocation's own lines and a codebase's load log on the shared LogLine: levels, a structured entry, the after-it-returned divider",
    width: 720,
    surface: 'canvas',
    render: () => <FunctionLogLinesCard />,
  },
  {
    id: 'function-log-lines-dark',
    group: 'Patterns',
    name: 'Function log lines, dark',
    subtitle: 'The same, in dark mode',
    width: 720,
    dark: true,
    surface: 'canvas',
    render: () => <FunctionLogLinesCard />,
  },
])
