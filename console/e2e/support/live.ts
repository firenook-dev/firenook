// Journey helpers for the console's one live connection (`src/lib/live`).
//
// `dropLive` cannot be a plain `page.route` abort: routing only intercepts
// new requests and leaves an EventSource that is already open alone. So it
// takes the product's own release path, with no test-only hook: shortened
// timings, the tab hidden until the channel gives its connection back, the
// live routes refused, and the tab shown again. The reconnect is then
// refused and the engine badge says so; `restoreLive` lets the next retry
// through, and the channel resumes every subscription from its cursor.

import type { BrowserContext, Page, Request } from '@playwright/test'

/** The key the channel reads its timings from (`TIMING_KEY` in `src/lib/live/channel.ts`). */
const TIMING_KEY = 'firenook.console.live-timing'
const LIVE_ROUTE = '**/console/api/v1/live**'

export interface LiveTiming {
  releaseMs?: number
  connectingMs?: number
  offlineMs?: number
}

const DROP_TIMING: Required<LiveTiming> = { releaseMs: 500, connectingMs: 500, offlineMs: 2000 }

/** Whether `request` is the live stream itself (not a subscription POST or the probe). */
export function isLiveStream(request: Request): boolean {
  const url = new URL(request.url())
  return request.method() === 'GET' && url.pathname.endsWith('/console/api/v1/live') && !url.search
}

/** Says to the page that its tab was hidden or shown, as the browser would. */
export async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.locator('html').evaluate((root, visibility) => {
    const shown = root.ownerDocument
    Object.defineProperty(shown, 'visibilityState', { configurable: true, get: () => visibility })
    Object.defineProperty(shown, 'hidden', {
      configurable: true,
      get: () => visibility === 'hidden',
    })
    shown.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

/** Drops the page's live connection and keeps it from coming back until `restoreLive`. */
export async function dropLive(page: Page, timing: LiveTiming = {}): Promise<void> {
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
    TIMING_KEY,
    JSON.stringify({ ...DROP_TIMING, ...timing }),
  ] as const)
  const released = Promise.race([
    page.waitForEvent('requestfailed', { predicate: isLiveStream }),
    page.waitForEvent('requestfinished', { predicate: isLiveStream }),
  ])
  await setVisibility(page, 'hidden')
  await released
  await page.route(LIVE_ROUTE, (route) => route.abort())
  await setVisibility(page, 'visible')
}

/** Lets the live connection back; the channel's next retry connects and resumes. */
export async function restoreLive(page: Page): Promise<void> {
  await page.unroute(LIVE_ROUTE)
}

/**
 * A page loaded hidden, as a tab opened in the background is: what the
 * document says before any of the page's scripts run. `setVisibility`
 * shows it later.
 */
export async function loadHidden(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The browser's document; this file is typed for Node, not the DOM.
    const shown = (globalThis as unknown as { document: object }).document
    Object.defineProperty(shown, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(shown, 'hidden', { configurable: true, get: () => true })
  })
}

/** How late a handed-over stream's abort may be reported (see `liveRequests`). */
const HANDOVER_GRACE_MS = 250

/**
 * Counts the live streams of a page, or of every page of a browser
 * context: how many were opened, how many are open now, and the most that
 * were ever open at once.
 */
export function liveRequests(target: Page | BrowserContext) {
  const events = target as Pick<Page, 'on' | 'off'>
  const open = new Set<Request>()
  const streams: { request: Request; start: number; end?: number }[] = []
  let opened = 0
  const onRequest = (request: Request) => {
    if (!isLiveStream(request)) return
    opened += 1
    open.add(request)
    streams.push({ request, start: performance.now() })
  }
  const onDone = (request: Request) => {
    open.delete(request)
    const stream = streams.find((each) => each.request === request && each.end === undefined)
    if (stream) stream.end = performance.now()
  }
  // The most streams open at once. A leader closes its stream before it lets
  // the next tab lead (channel.ts `stopLeading`), but the browser reports the
  // old stream's abort from another process, a moment after the new one's
  // request on a slow machine: a stream that ended within HANDOVER_GRACE_MS of
  // a newer one starting was already closed when that one opened.
  const most = () =>
    streams.reduce(
      (highest, stream) =>
        Math.max(
          highest,
          1 +
            streams.filter(
              (other) =>
                other !== stream &&
                other.start <= stream.start &&
                (other.end === undefined || other.end - stream.start > HANDOVER_GRACE_MS),
            ).length,
        ),
      0,
    )
  // A closed page's requests end without an event: they are not open.
  const living = () =>
    [...open].filter((request) => {
      try {
        return !request.frame().page().isClosed()
      } catch {
        // A request with no frame (a worker's) is no page's live stream.
        return false
      }
    })
  events.on('request', onRequest)
  events.on('requestfinished', onDone)
  events.on('requestfailed', onDone)
  return {
    open: () => living().length,
    opened: () => opened,
    most,
    dispose() {
      events.off('request', onRequest)
      events.off('requestfinished', onDone)
      events.off('requestfailed', onDone)
    },
  }
}
