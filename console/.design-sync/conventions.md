# Building with the Firenook component library

This library is Cloudflare's Kumo under the Firenook theme, plus three Firenook pieces. Every component is on `window.Firenook` and is the real compiled Kumo code. What you build with it is the Firenook console: the emulator's own UI for Firestore, Authentication, Storage, Functions, Extensions, Pub/Sub, Eventarc, Cloud Tasks, Logs and Requests.

## Setup and wrapping

- No provider is required for styling. Tokens and fonts come from `styles.css`; components render styled with nothing wrapped around them.
- Wrap the app in `Toasty` to show toasts, and call `useKumoToastManager().add({ title, description, variant })` from inside it. Wrap a region in `TooltipProvider` so tooltips across it share one delay.
- Dark mode: set `data-mode="dark"` on the root element. Never use `dark:` classes; every token flips by itself.
- Sidebar: `Sidebar.Provider` wraps the whole page (`Sidebar` on one side, the page content as its sibling). Inside a bounded panel add `contained`.
- Floating pieces (`Dialog`, `Popover`, `DropdownMenu`, `CommandPalette`, `Tooltip`, toasts) portal to the body. Give the app root `isolation: isolate` (the `isolate` class).

## The styling idiom: Tailwind utilities on Kumo's semantic tokens

Style layout with Tailwind utility classes; colour only through Kumo tokens. Raw Tailwind colours (`bg-blue-500`, `text-gray-600`) do not exist in this stylesheet and render unstyled.

| Family                  | Classes that exist                                                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces                | `bg-kumo-canvas` (page ground), `bg-kumo-base` (component), `bg-kumo-elevated` (card header), `bg-kumo-recessed` (tab track), `bg-kumo-tint` (hover, alternate rows), `bg-kumo-contrast`, `bg-kumo-control`                                                                |
| Text                    | `text-kumo-strong`, `text-kumo-default`, `text-kumo-subtle`, `text-kumo-inactive`, `text-kumo-placeholder`, `text-kumo-inverse`, `text-kumo-link`, `text-kumo-brand`, `text-kumo-info`, `text-kumo-success`, `text-kumo-warning`, `text-kumo-danger`                       |
| Accent and status fills | `bg-kumo-brand` (ember; primary action, active nav), `bg-kumo-info`, `bg-kumo-success`, `bg-kumo-warning`, `bg-kumo-danger`, and their `-tint` variants for badges and banners                                                                                             |
| Lines                   | `ring ring-kumo-hairline` between flat surfaces; `ring ring-kumo-line` on an elevated surface with `shadow-md`; `border-kumo-hairline`, `border-kumo-line`, `divide-kumo-hairline`; `ring-kumo-brand` for focus                                                            |
| Layout                  | `flex`, `grid`, `gap-{0.5..16}`, `grid-cols-{1..12}`, `items-*`, `justify-*`, `p-`/`m-` on the 4 px scale (`p-1` … `p-24`), `w-`/`h-` on the scale plus `w-full`, `h-full`, `size-{4..16}`, `max-w-{xs..7xl}`, `min-w-0`, `sm:`/`md:`/`lg:` prefixes on the layout classes |
| Type                    | `text-xs` 12, `text-sm` 13, `text-base` 14 (all content text), `text-lg` 16 and `text-xl` 20 (headings only); `font-medium` for emphasis, `font-semibold` for headings, never `font-bold`; `font-mono` for paths, ids, values and code, at `text-[0.9em]` when inline      |
| Shape                   | `rounded-sm` 4, `rounded-md` 6, `rounded-lg` 8, `rounded-xl` 12, `rounded-full`; inner radius plus padding equals outer radius                                                                                                                                             |

Arbitrary values are limited to the ones compiled in: `text-[0.9em]`, `text-[10px]` to `text-[13px]`, and `w-`/`h-`/`min-h-`/`max-h-[…px]` at 120, 160, 200, 240, 280, 320, 360, 400, 420, 480, 520, 560, 640, 720, 800, 960. Any other bracket value renders nothing; use the scale.

Rules the console holds to: no `dark:` classes; no colour transitions on hover; no `tracking-*`; no `font-bold`; sentence-case headings; content text stays 14 px; dialogs stay mounted and toggle with `open`; never nest one `LayerCard` in another; `Switch` uses `variant="neutral"` (its default is a hard-coded blue that matches nothing else); the ember accent is reserved for the primary action, active navigation and links.

## Where the truth lives

- `styles.css` and its imports (`_ds_bundle.css`, `tokens/`): every token and utility that exists.
- `components/<group>/<Name>/<Name>.prompt.md`: the props, variants and usage examples per component. Kumo's own component docs are reproduced there.
- `guidelines/kumo-design-rules.md`: Kumo's design rules (spacing, type, borders, dialogs). The console follows them as written.

## One idiomatic build: a data grid with a header bar

```tsx
import {
  Badge,
  Button,
  InlineCopyText,
  LayerCard,
  Link,
  Table,
  Text,
  Toolbar,
  TypeBadge,
} from '@firenook/kit'
import { ArrowsClockwiseIcon, FunnelSimpleIcon, PlusIcon } from '@phosphor-icons/react'

export function Orders() {
  return (
    <div className="grid gap-4 bg-kumo-canvas p-6 text-kumo-default">
      <div className="flex items-center gap-3">
        <Text variant="heading" size="lg" as="h1">
          Firestore
        </Text>
        <Badge variant="success" appearance="dot">
          running
        </Badge>
        <span className="ml-auto flex items-center gap-2">
          <Toolbar className="w-80">
            <Toolbar.Input
              aria-label="Search documents"
              placeholder="Search documents"
              className="flex-1"
            />
            <Toolbar.Button icon={FunnelSimpleIcon} aria-label="Filter" />
            <Toolbar.Button icon={ArrowsClockwiseIcon} aria-label="Refresh" />
          </Toolbar>
          <Button variant="primary" icon={<PlusIcon />}>
            Add document
          </Button>
        </span>
      </div>
      <LayerCard className="p-0">
        <Table>
          <Table.Header variant="compact">
            <Table.Row>
              <Table.Head>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[12px]">status</span>
                  <TypeBadge type="string" />
                </span>
              </Table.Head>
              <Table.Head>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[12px]">customer</span>
                  <TypeBadge type="reference" />
                </span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            <Table.Row className="group">
              <Table.Cell>
                <Badge variant="success" appearance="dot">
                  paid
                </Badge>
              </Table.Cell>
              <Table.Cell>
                <Link href="#" className="font-mono text-[0.9em]">
                  users/u_9f3k2
                </Link>
              </Table.Cell>
            </Table.Row>
          </Table.Body>
        </Table>
      </LayerCard>
      <Text variant="secondary" size="sm">
        Rows 1–50 of 12,345 ·{' '}
        <InlineCopyText value="users/u_9f3k2/orders" className="font-mono text-[0.9em]">
          users/u_9f3k2/orders
        </InlineCopyText>
      </Text>
    </div>
  )
}
```

Icons come from `@phosphor-icons/react` (`PlusIcon`, `TrashIcon`, `DatabaseIcon`, `UsersIcon`…); pass a component to `icon` on `Button`, `Toolbar.Button` and `DropdownMenu.Item`, or an element where the example shows one.
