import { Text } from '@cloudflare/kumo'
import { defineCards } from '../registry'
import { Row, Section, Stack, Swatch } from './shared'

function Colours() {
  return (
    <Stack>
      <Section
        title="Surfaces"
        note="From the page ground up: canvas, base, elevated, recessed, tint, contrast."
      >
        <div className="flex flex-wrap gap-4">
          <Swatch token="bg-kumo-canvas" className="bg-kumo-canvas" label="page ground" />
          <Swatch token="bg-kumo-base" className="bg-kumo-base" label="component" />
          <Swatch token="bg-kumo-elevated" className="bg-kumo-elevated" label="card header" />
          <Swatch token="bg-kumo-recessed" className="bg-kumo-recessed" label="tab track" />
          <Swatch token="bg-kumo-tint" className="bg-kumo-tint" label="hover, table" />
          <Swatch token="bg-kumo-contrast" className="bg-kumo-contrast" label="inverted" />
        </div>
      </Section>
      <Section title="Text">
        <div className="flex flex-wrap gap-4">
          <Swatch token="text-kumo-strong" className="bg-kumo-base" text="text-kumo-strong" />
          <Swatch token="text-kumo-default" className="bg-kumo-base" text="text-kumo-default" />
          <Swatch token="text-kumo-subtle" className="bg-kumo-base" text="text-kumo-subtle" />
          <Swatch token="text-kumo-inactive" className="bg-kumo-base" text="text-kumo-inactive" />
          <Swatch token="text-kumo-link" className="bg-kumo-base" text="text-kumo-link" />
          <Swatch token="text-kumo-inverse" className="bg-kumo-contrast" text="text-kumo-inverse" />
        </div>
      </Section>
      <Section
        title="Brand and status"
        note="Solid tokens for fills, dots and bars; tints for badges and banners."
      >
        <div className="flex flex-wrap gap-4">
          <Swatch token="bg-kumo-brand" className="bg-kumo-brand" text="text-white" />
          <Swatch token="bg-kumo-info" className="bg-kumo-info" text="text-white" />
          <Swatch token="bg-kumo-success" className="bg-kumo-success" text="text-white" />
          <Swatch token="bg-kumo-warning" className="bg-kumo-warning" text="text-black" />
          <Swatch token="bg-kumo-danger" className="bg-kumo-danger" text="text-white" />
        </div>
        <div className="flex flex-wrap gap-4">
          <Swatch token="bg-kumo-info-tint" className="bg-kumo-info-tint" text="text-kumo-info" />
          <Swatch
            token="bg-kumo-success-tint"
            className="bg-kumo-success-tint"
            text="text-kumo-success"
          />
          <Swatch
            token="bg-kumo-warning-tint"
            className="bg-kumo-warning-tint"
            text="text-kumo-warning"
          />
          <Swatch
            token="bg-kumo-danger-tint"
            className="bg-kumo-danger-tint"
            text="text-kumo-danger"
          />
        </div>
      </Section>
      <Section
        title="Lines"
        note="Hairline separates flat surfaces; line edges an elevated surface beside a shadow; focus is the keyboard ring."
      >
        <div className="flex flex-wrap gap-4">
          <Swatch
            token="ring-kumo-hairline"
            className="bg-kumo-base ring-2 ring-kumo-hairline"
            ring={false}
          />
          <Swatch
            token="ring-kumo-line"
            className="bg-kumo-base ring-2 ring-kumo-line"
            ring={false}
          />
          <Swatch
            token="ring-kumo-focus"
            className="bg-kumo-base ring-2 ring-kumo-focus"
            ring={false}
          />
          <Swatch
            token="ring-kumo-brand"
            className="bg-kumo-base ring-2 ring-kumo-brand"
            ring={false}
          />
        </div>
      </Section>
    </Stack>
  )
}

defineCards([
  {
    id: 'colours-light',
    group: 'Foundations',
    name: 'Colours, light',
    subtitle: 'Surfaces, text, brand and status, lines, by token name',
    width: 880,
    surface: 'canvas',
    render: () => <Colours />,
  },
  {
    id: 'colours-dark',
    group: 'Foundations',
    name: 'Colours, dark',
    subtitle: 'The same tokens under data-mode="dark"',
    width: 880,
    dark: true,
    surface: 'canvas',
    render: () => <Colours />,
  },
  {
    id: 'typography',
    group: 'Foundations',
    name: 'Typography',
    subtitle: "Kumo's four sizes, three weights, headings, mono for data",
    width: 880,
    render: () => (
      <Stack>
        <Section
          title="Scale"
          note="Content text is 14 px. 16 px and above are headings. Never bold: semibold for headings, medium for emphasis."
        >
          <Row label="heading lg · 20">
            <Text variant="heading" size="lg" as="h1">
              Firestore
            </Text>
          </Row>
          <Row label="heading · 16">
            <Text variant="heading" as="h2">
              Recent requests
            </Text>
          </Row>
          <Row label="body · 14">
            <Text>Every section is a screen the console will own.</Text>
          </Row>
          <Row label="body bold">
            <Text bold>demo-shop-local</Text>
          </Row>
          <Row label="secondary · 14">
            <Text variant="secondary">Updated 2 minutes ago</Text>
          </Row>
          <Row label="small · 13">
            <Text size="sm">Rows 1–50 of 12,345</Text>
          </Row>
          <Row label="xs · 12">
            <Text size="xs">Ctrl K opens the palette</Text>
          </Row>
        </Section>
        <Section
          title="Mono"
          note="Paths, ids, values, timestamps and code. Inline mono sits at 0.9 em of the surrounding text."
        >
          <Row label="mono · 13">
            <Text variant="mono">users/u_9f3k2/orders/o_20251</Text>
          </Row>
          <Row label="mono lg · 14">
            <Text variant="mono" size="lg">
              {'{ "status": "paid", "total": 42 }'}
            </Text>
          </Row>
          <Row label="mono secondary">
            <Text variant="mono-secondary">2026-09-20T10:14:02.117Z</Text>
          </Row>
          <Row label="inline">
            <Text>
              Edit <span className="font-mono text-[0.9em]">firestore.rules</span> to change access.
            </Text>
          </Row>
        </Section>
        <Section title="States">
          <Row label="success">
            <Text variant="success">Saved at revision 4,812</Text>
          </Row>
          <Row label="error">
            <Text variant="error">Permission denied by rules line 14</Text>
          </Row>
        </Section>
      </Stack>
    ),
  },
  {
    id: 'spacing-radius',
    group: 'Foundations',
    name: 'Spacing, radius, elevation',
    subtitle: '4 px scale, concentric radii, ring-plus-shadow instead of borders',
    width: 880,
    render: () => (
      <Stack>
        <Section
          title="Spacing"
          note="Tailwind's 4 px scale. Related text sits closer than the content it belongs to."
        >
          <div className="flex items-end gap-4">
            {[1, 1.5, 2, 3, 4, 6, 8].map((step) => (
              <div key={step} className="grid gap-1.5 text-center">
                <div
                  className="mx-auto w-6 rounded-sm bg-kumo-brand"
                  style={{ height: step * 4 }}
                />
                <span className="font-mono text-[11px] text-kumo-subtle">
                  {step} · {step * 4}px
                </span>
              </div>
            ))}
          </div>
        </Section>
        <Section
          title="Radius"
          note="Inner radius plus padding equals outer radius when edges sit 8 px apart or closer."
        >
          <div className="flex flex-wrap gap-4">
            {[
              ['rounded-sm', 'rounded-sm'],
              ['rounded-md', 'rounded-md'],
              ['rounded-lg', 'rounded-lg'],
              ['rounded-xl', 'rounded-xl'],
              ['rounded-full', 'rounded-full'],
            ].map(([token, cls]) => (
              <div key={token} className="grid gap-1.5">
                <div className={`h-14 w-24 bg-kumo-tint ring ring-kumo-line ${cls}`} />
                <span className="font-mono text-[11px] text-kumo-subtle">{token}</span>
              </div>
            ))}
            <div className="grid gap-1.5">
              <div className="rounded-xl bg-kumo-recessed p-1">
                <div className="h-12 w-[88px] rounded-lg bg-kumo-base ring ring-kumo-line" />
              </div>
              <span className="font-mono text-[11px] text-kumo-subtle">xl outside lg</span>
            </div>
          </div>
        </Section>
        <Section
          title="Elevation"
          note="A flat surface gets a hairline ring. An elevated one gets a line ring and a shadow. Never a border with a shadow."
        >
          <div className="flex flex-wrap gap-6">
            <div className="grid gap-1.5">
              <div className="h-20 w-40 rounded-lg bg-kumo-base ring ring-kumo-hairline" />
              <span className="font-mono text-[11px] text-kumo-subtle">ring-kumo-hairline</span>
            </div>
            <div className="grid gap-1.5">
              <div className="h-20 w-40 rounded-lg bg-kumo-base shadow-md ring ring-kumo-line" />
              <span className="font-mono text-[11px] text-kumo-subtle">
                shadow-md ring-kumo-line
              </span>
            </div>
            <div className="grid gap-1.5">
              <div className="h-20 w-40 rounded-lg bg-kumo-base shadow-lg ring ring-kumo-line" />
              <span className="font-mono text-[11px] text-kumo-subtle">shadow-lg (popovers)</span>
            </div>
          </div>
        </Section>
      </Stack>
    ),
  },
])
