import { Badge, Text } from '@cloudflare/kumo'
import { CampfireIcon } from '@phosphor-icons/react'
import { defineCards } from '../registry'
import { Row, Section, Stack } from './shared'

function Mark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="flex items-center justify-center rounded-lg bg-kumo-brand text-white"
      style={{ width: size, height: size }}
    >
      <CampfireIcon size={Math.round(size * 0.58)} weight="bold" />
    </span>
  )
}

function Accent({
  name,
  fill,
  hover,
  text,
  status,
}: {
  name: string
  fill: string
  hover: string
  text: string
  status: 'in use' | 'considered'
}) {
  return (
    <div className="grid w-52 gap-2">
      <div className="flex items-center gap-2">
        <Text bold>{name}</Text>
        <Badge variant={status === 'in use' ? 'success' : 'neutral'} appearance="dot">
          {status}
        </Badge>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <div className="h-12 rounded-lg" style={{ background: fill }} />
        <div className="h-12 rounded-lg" style={{ background: hover }} />
        <div className="flex h-12 items-center justify-center rounded-lg ring ring-kumo-line">
          <span className="text-sm font-medium" style={{ color: text }}>
            Link
          </span>
        </div>
      </div>
      <div className="grid font-mono text-[11px] text-kumo-subtle">
        <span>fill {fill}</span>
        <span>hover {hover}</span>
      </div>
    </div>
  )
}

defineCards([
  {
    id: 'identity',
    group: 'Brand',
    name: 'Identity',
    subtitle: 'Mark, wordmark, the ember accent and the type pair',
    width: 880,
    render: () => (
      <Stack>
        <Section
          title="Firenook"
          note="One accent and one type pair on top of Kumo. Everything else is Kumo's own token set, so components keep their tested light and dark behaviour."
        >
          <Row label="Mark">
            <Mark size={48} />
            <Mark size={28} />
            <Mark size={20} />
          </Row>
          <Row label="Wordmark">
            <span className="flex items-center gap-2">
              <Mark />
              <span className="text-[20px] leading-none font-semibold text-kumo-strong">
                Firenook
              </span>
              <span className="text-[20px] leading-none text-kumo-subtle">console</span>
            </span>
          </Row>
        </Section>
        <Section
          title="Accent"
          note="Ember is in use: oklch(0.55 0.19 35). White on it and it on white both measure 5.3:1, so it works as a button fill and as link text. The two alternatives were considered and set aside."
        >
          <div className="flex flex-wrap gap-6">
            <Accent name="Ember" fill="#c83406" hover="#a82700" text="#c83406" status="in use" />
            <Accent
              name="Kumo blue"
              fill="#056dff"
              hover="#1d4ed8"
              text="#1e40af"
              status="considered"
            />
            <Accent name="Teal" fill="#007570" hover="#005f5b" text="#007570" status="considered" />
          </div>
        </Section>
        <Section
          title="Type"
          note="IBM Plex Sans for the interface, IBM Plex Mono for paths, ids, values and code. Both self-hosted; no CDN call from a local tool."
        >
          <Row label="Sans">
            <span className="text-[20px] leading-tight text-kumo-strong">
              Documents, users, queues and rules, all live.
            </span>
          </Row>
          <Row label="Mono">
            <span className="font-mono text-[14px] text-kumo-default">
              users/u_9f3k2/orders/o_20251 · 2026-09-20T10:14:02Z
            </span>
          </Row>
        </Section>
      </Stack>
    ),
  },
])
