// The kit's perf harness (foundation §8.4): FeedList and JsonView on a page
// of their own, for the @perf journeys in `e2e/shell.spec.ts`. A primitive's
// frame budget is its own — the same number on whichever page draws it — and
// these two are measured before any page renders them at full load. The
// theme view holds every button variant and the text and marks a page
// draws, for the contrast journeys in `e2e/shell-theme.spec.ts`. No
// console API is involved, so nothing is mocked: the feed is handed exactly
// what the live channel hands a page (one window of items every 100 ms,
// parsed once), and the tree a value just parsed from a 5 MB text.
//
// `e2e/support/kit.ts` builds it with the console's own plugins (React
// compiler, Tailwind, the `@` alias) in production mode and serves it under
// the engine's `/console/`, so it takes the console's fonts and theme.
// `?view=feed|json|theme`, `?mode=light|dark`; `window.__kit` drives it.

import { TooltipProvider } from '@cloudflare/kumo'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './harness.css'
import { FeedHarness, feed } from './feed'
import { JsonHarness, showJson } from './json'
import type { KitHarness } from './runs'
import { ThemeHarness, measureTheme } from './theme'

declare global {
  interface Window {
    __kit?: KitHarness
  }
}

const params = new URLSearchParams(window.location.search)
const view = params.get('view') ?? 'feed'
document.documentElement.dataset['mode'] = params.get('mode') === 'dark' ? 'dark' : 'light'

window.__kit = { ready: false, feed, json: showJson, theme: measureTheme }

const container = document.getElementById('root')
if (!container) throw new Error('The harness root element is missing')

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      {view === 'json' ? <JsonHarness /> : view === 'theme' ? <ThemeHarness /> : <FeedHarness />}
    </TooltipProvider>
  </StrictMode>,
)

void document.fonts.ready.then(() => {
  requestAnimationFrame(() => {
    if (window.__kit) window.__kit.ready = true
  })
})
