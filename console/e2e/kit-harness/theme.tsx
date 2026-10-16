// The theme half of the kit harness: every Kumo button variant, an
// underline tab bar, a link, a status word and an input with a placeholder,
// drawn with the console's own theme, and `measureTheme`, which reads back
// what the browser paints and works out each contrast ratio (WCAG 2) the
// way a reader meets it. The journeys in `e2e/shell-theme.spec.ts` hold the
// numbers; `src/theme.css` says why each colour is what it is.

import { Button, Input, Tabs } from '@cloudflare/kumo'
import { PlusIcon, TrashIcon } from '@phosphor-icons/react'
import type { ThemeRun } from './runs'

const VARIANTS = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'secondary-destructive',
] as const

/** The grounds a page puts text on, from the page up. */
const SURFACES = ['base', 'canvas', 'elevated', 'recessed', 'tint'] as const

/** Text tokens a page writes in, each needing 4.5:1. */
const TEXT = ['default', 'subtle', 'link', 'brand', 'success', 'warning', 'danger', 'info'] as const

/** Fills that draw marks (a dot, a bar, a ring), each needing 3:1. */
const MARKS: Record<string, string> = {
  flame: '--color-firenook-flame',
  ink: '--color-kumo-brand',
  focus: '--color-kumo-focus',
  danger: '--color-kumo-danger',
  warning: '--color-kumo-warning',
  success: '--color-kumo-success',
}

export function ThemeHarness() {
  return (
    <div className="grid gap-6 bg-kumo-base p-6 text-kumo-default" data-testid="theme-harness">
      <div className="flex flex-wrap items-center gap-3">
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant} data-variant={variant}>
            {variant}
          </Button>
        ))}
        <Button variant="primary" icon={<PlusIcon />} data-variant="primary">
          Add document
        </Button>
        <Button variant="destructive" icon={<TrashIcon />} data-variant="destructive">
          Delete 3 documents
        </Button>
      </div>
      <div className="flex h-11 items-center border-b border-kumo-line px-3">
        <Tabs
          variant="underline"
          size="sm"
          value="rules"
          tabs={[
            { value: 'rules', label: 'Rules' },
            { value: 'history', label: 'History' },
          ]}
        />
      </div>
      <div className="flex items-center gap-4 text-[13px]">
        <a href="#theme" className="text-kumo-link" data-testid="theme-link">
          Open the engine’s details
        </a>
        <Input aria-label="Filter" placeholder="provider:google.com is:disabled" />
      </div>
    </div>
  )
}

/** The `color(srgb r g b / a)` the browser resolves a colour to, as numbers. */
function srgb(css: string, host: Element): { rgb: [number, number, number]; alpha: number } {
  const probe = document.createElement('span')
  host.append(probe)
  probe.style.color = `color-mix(in srgb, ${css} 100%, transparent)`
  const resolved = getComputedStyle(probe).color
  probe.remove()
  const numbers = resolved.match(/-?[\d.]+/g)
  if (!numbers) throw new Error(`${css} resolved to "${resolved}", not a colour`)
  const [r = 0, g = 0, b = 0, alpha = 1] = numbers.map(Number)
  return { rgb: [r, g, b], alpha }
}

function channel(value: number): number {
  const unit = Math.min(1, Math.max(0, value))
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number]
  return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100
}

/** The ground behind an element: its own fill, or the first one under it, composited. */
function groundOf(element: Element): [number, number, number] {
  const layers: Array<{ rgb: [number, number, number]; alpha: number }> = []
  for (let node: Element | null = element; node; node = node.parentElement) {
    const fill = srgb(getComputedStyle(node).backgroundColor, document.body)
    if (fill.alpha > 0) layers.push(fill)
    if (fill.alpha >= 1) break
  }
  let ground: [number, number, number] = [1, 1, 1]
  for (const layer of layers.toReversed())
    ground = ground.map((value, index) => {
      const top = layer.rgb[index] ?? 0
      return top * layer.alpha + value * (1 - layer.alpha)
    }) as [number, number, number]
  return ground
}

export function measureTheme(): ThemeRun {
  const root = document.querySelector('[data-testid="theme-harness"]')
  if (!root) throw new Error('The theme harness is not on the page')
  const checks: ThemeRun['checks'] = []
  const surface = (name: string) => srgb(`var(--color-kumo-${name})`, root).rgb

  // A filled button's label sits halfway down its gradient, which hover
  // lifts at the head, so both are measured where the label is.
  for (const button of root.querySelectorAll('[data-kumo-component="Button"]')) {
    const label = button.textContent?.trim() ?? ''
    const text = srgb(getComputedStyle(button).color, button).rgb
    if ((button.getAttribute('style') ?? '').includes('--kumo-button-emphasis')) {
      const stop = (name: string) => {
        const [r, g, b] = srgb(`var(--kumo-button-emphasis-${name})`, button).rgb
        return `color(srgb ${r} ${g} ${b})`
      }
      const foot = stop('gradient-end')
      const rest = srgb(`color-mix(in oklab, ${stop('gradient-start')}, ${foot})`, button).rgb
      const hover = srgb(`color-mix(in oklab, ${stop('bg')}, ${foot})`, button).rgb
      checks.push({ what: `${label} button`, ratio: ratio(text, rest), need: 4.5 })
      checks.push({ what: `${label} button, hovered`, ratio: ratio(text, hover), need: 4.5 })
    } else checks.push({ what: `${label} button`, ratio: ratio(text, groundOf(button)), need: 4.5 })
  }

  for (const name of TEXT) {
    const ink = srgb(`var(--text-color-kumo-${name})`, root).rgb
    for (const ground of SURFACES)
      checks.push({
        what: `${name} text on ${ground}`,
        ratio: ratio(ink, surface(ground)),
        need: 4.5,
      })
  }
  for (const [name, token] of Object.entries(MARKS)) {
    const fill = srgb(`var(${token})`, root).rgb
    for (const ground of SURFACES)
      checks.push({
        what: `${name} mark on ${ground}`,
        ratio: ratio(fill, surface(ground)),
        need: 3,
      })
  }

  // Resolved beside the input, not in it: an input's children are never
  // styled, so a probe inside one reads back nothing.
  const input = root.querySelector('input')!
  const placeholder = srgb(getComputedStyle(input, '::placeholder').color, root).rgb
  checks.push({ what: 'placeholder', ratio: ratio(placeholder, groundOf(input)), need: 4.5 })

  const underline = root.querySelector('.kumo-tabs-list .bg-kumo-brand')!
  const flame = srgb('var(--color-firenook-flame)', root).rgb
  const drawn = srgb(getComputedStyle(underline).backgroundColor, root).rgb
  checks.push({ what: 'tab underline', ratio: ratio(drawn, surface('base')), need: 3 })

  // OKLCH chroma: ink is a grey and the danger red is a colour.
  const chroma = (css: string) => {
    const probe = document.createElement('span')
    root.append(probe)
    probe.style.color = `color-mix(in oklch, ${css} 100%, transparent)`
    const [, c = 0] = getComputedStyle(probe)
      .color.match(/-?[\d.]+/g)!
      .map(Number)
    probe.remove()
    return c
  }
  return {
    checks,
    primaryChroma: chroma('var(--color-kumo-brand)'),
    underlineIsFlame: drawn.every((value, index) => Math.abs(value - (flame[index] ?? 0)) < 0.002),
  }
}
