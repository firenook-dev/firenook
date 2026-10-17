import { Button, Text } from '@cloudflare/kumo'
import { PlusIcon, TrashIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { FirenookLogo } from '@/components/kit/firenook-logo'
import { defineCards } from '../registry'
import { Row, Section, Stack } from './shared'

function Role({
  name,
  values,
  job,
  children,
}: {
  name: string
  values: string
  job: string
  children: ReactNode
}) {
  return (
    <div className="grid w-60 content-start gap-2">
      <Text bold>{name}</Text>
      <div className="flex h-12 items-center gap-3">{children}</div>
      <span className="font-mono text-[11px] text-kumo-subtle">{values}</span>
      <Text variant="secondary" size="xs">
        {job}
      </Text>
    </div>
  )
}

defineCards([
  {
    id: 'identity',
    group: 'Brand',
    name: 'Identity',
    subtitle: 'The logo, blue and flame, and the type pair',
    width: 880,
    render: () => (
      <Stack>
        <Section
          title="Firenook"
          note="The brand kit lives in brand/ at the repository's root; the console draws the flat horizontal logo, whose wordmark is charcoal on light and white on dark. Everything else is Kumo's own token set, so components keep their tested light and dark behaviour, but for four colours set where Kumo's read below AA on these grounds (theme.css lists them)."
        >
          <Row label="Logo">
            <FirenookLogo className="h-9 w-auto" />
            <FirenookLogo className="h-6 w-auto" />
          </Row>
        </Section>
        <Section
          title="Colour"
          note="Split by job, the way Firebase and Cloudflare split theirs: a flame logo beside a blue for everything that can be pressed. The flame never fills a button or colours a state: vermilion is within ten degrees of the danger red and amber is the warning, so red means delete or failed and amber a warning, nothing else."
        >
          <div className="flex flex-wrap gap-6">
            <Role
              name="Blue"
              values="#1c53cf · rings and dots in dark #4c8eef"
              job="Kumo's brand token: the primary button, links, focus rings, progress, the unsaved dot. Opposite the flame on the wheel, and no state's colour; white on the button reads 5.5:1."
            >
              <Button variant="primary" icon={<PlusIcon />}>
                Add document
              </Button>
              <span className="text-sm text-kumo-link">Open logs</span>
            </Role>
            <Role
              name="Flame"
              values="#F23818 · as text oklch(0.55 0.19 35)"
              job="The logo's vermilion marks where you are: the active tab, the selected row, the open document, the current sort. Never a link: beside an error or a warning it reads as a third problem."
            >
              <span className="relative flex h-8 items-center px-1 text-sm text-kumo-default">
                Rules
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-firenook-flame" />
              </span>
              <span className="flex h-7 items-center rounded-md bg-kumo-tint pr-2 pl-2.5 text-sm text-kumo-default shadow-[inset_2px_0_0_var(--color-firenook-flame)]">
                orders
              </span>
            </Role>
            <Role
              name="Danger"
              values="oklch(0.5 0.2 27) on a Delete"
              job="Kumo's red for dots, bars and text; a Delete button fills deeper so its white label reads, 5.6:1 at rest."
            >
              <Button variant="destructive" icon={<TrashIcon />}>
                Delete
              </Button>
            </Role>
          </div>
        </Section>
        <Section
          title="Type"
          note="Inter for the interface, the face Kumo's own documentation renders in, so every component looks as Kumo designed it; IBM Plex Mono for paths, ids, values and code. Both self-hosted; no CDN call from a local tool. The brand's Figtree is the wordmark's, drawn as outlines."
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
