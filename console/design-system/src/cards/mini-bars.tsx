// The small volume bars every section shares (observe's isolated commit
// 11, built by the foundation so every stream has it from G2): the Logs
// strip stacked by level, the Overview's last hour of problems, a topic's
// last minute of publishes as one series, and the brush of a dragged range.

import { Text } from '@cloudflare/kumo'
import { MiniBars } from '@/components/console/mini-bars'
import { defineCards } from '../registry'
import { Section, Stack } from './shared'

/** A deterministic hour of log lines per minute: info, warn, error. */
const HOUR: number[][] = Array.from({ length: 60 }, (_, minute) => {
  const wave = Math.round(40 + 30 * Math.sin(minute / 6) + ((minute * 37) % 23))
  const warn = minute % 9 === 0 ? 6 : minute % 5 === 0 ? 2 : 0
  const error = minute === 41 ? 14 : minute % 17 === 0 ? 1 : 0
  return [minute === 41 ? 160 : wave, warn, error]
})

const PROBLEMS: number[][] = HOUR.map(([, warn = 0, error = 0]) => [0, warn, error])

const PUBLISHES: number[][] = Array.from({ length: 60 }, (_, second) => [
  second > 44 ? 0 : Math.max(0, Math.round(8 + 6 * Math.cos(second / 4) - (second % 7))),
])

const LEVELS = [
  { label: 'info and debug', tone: 'neutral' },
  { label: 'warnings', tone: 'warning' },
  { label: 'errors', tone: 'danger' },
] as const

const minuteLabel = (index: number) => {
  const [info = 0, warn = 0, error = 0] = HOUR[index] ?? []
  const from = `12:${String(index).padStart(2, '0')}`
  return `${from} · ${info + warn + error} lines · ${error} errors · ${warn} warnings`
}

function MiniBarsCard() {
  return (
    <Stack>
      <Section
        title="The Logs strip"
        note="Sixty buckets stacked by level, scaled to the busiest; a minute with one error is still a pixel. Hover says the bucket; click or drag picks a range."
      >
        <div className="grid gap-2 rounded-lg bg-kumo-base px-3 py-3 ring ring-kumo-line">
          <MiniBars
            buckets={HOUR}
            series={LEVELS}
            height={24}
            label="Log lines per minute, last hour"
            tooltip={minuteLabel}
            onPick={() => {}}
          />
          <Text variant="secondary" size="xs">
            24 px, the height of a toolbar row&apos;s contents
          </Text>
        </div>
      </Section>
      <Section
        title="Recent problems"
        note="The Overview's last hour: warnings and errors only, 20 px."
      >
        <div className="flex items-center gap-3 rounded-lg bg-kumo-base px-3 py-3 ring ring-kumo-line">
          <div className="w-48">
            <MiniBars
              buckets={PROBLEMS}
              series={LEVELS}
              height={20}
              label="Problems per minute, last hour"
            />
          </div>
          <Text variant="secondary" size="xs">
            last hour
          </Text>
        </div>
      </Section>
      <Section
        title="One series"
        note="A Pub/Sub topic's last minute of publishes: the sparkline case, gone quiet fifteen seconds ago."
      >
        <div className="flex items-center gap-3 rounded-lg bg-kumo-base px-3 py-3 ring ring-kumo-line">
          <div className="w-40">
            <MiniBars
              buckets={PUBLISHES}
              series={[{ label: 'publishes', tone: 'neutral' }]}
              height={20}
              label="Publishes per second, last minute"
            />
          </div>
          <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">412/min</span>
        </div>
      </Section>
    </Stack>
  )
}

defineCards([
  {
    id: 'mini-bars',
    group: 'Components',
    name: 'Mini bars',
    subtitle:
      'Stacked volume bars without a chart library: the Logs strip, recent problems, a one-series sparkline',
    width: 880,
    surface: 'canvas',
    render: () => <MiniBarsCard />,
  },
  {
    id: 'mini-bars-dark',
    group: 'Components',
    name: 'Mini bars, dark',
    subtitle: 'The same, in dark mode',
    width: 880,
    dark: true,
    surface: 'canvas',
    render: () => <MiniBarsCard />,
  },
])
