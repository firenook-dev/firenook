// Journey helpers for the console's one live connection (`src/lib/live`).
//
// `dropLive` cannot be a plain `page.route` abort: routing only intercepts
// new requests and leaves an EventSource that is already open alone. So it
// takes the product's own release path, with no test-only hook: shortened
// timings, the tab hidden until the channel gives its connection back, the
// live routes refused, and the tab shown again. The reconnect is then
// refused and the engine badge says so; `restoreLive` lets the next retry
// through, and the channel resumes every subscription from its cursor.

import type { Page, Request } from '@playwright/test'

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

async function setVisibility(page: Page, state: 'hidden' | 'visible') {
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

/** Counts the page's live streams: how many were opened, and how many are open now. */
export function liveRequests(page: Page) {
  const open = new Set<Request>()
  let opened = 0
  const onRequest = (request: Request) => {
    if (!isLiveStream(request)) return
    opened += 1
    open.add(request)
  }
  const onDone = (request: Request) => {
    open.delete(request)
  }
  page.on('request', onRequest)
  page.on('requestfinished', onDone)
  page.on('requestfailed', onDone)
  return {
    open: () => open.size,
    opened: () => opened,
    dispose() {
      page.off('request', onRequest)
      page.off('requestfinished', onDone)
      page.off('requestfailed', onDone)
    },
  }
}
