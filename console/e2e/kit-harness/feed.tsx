// The feed half of the kit harness: a Logs-shaped FeedList (24 px LogLine
// rows, newest last, following, a 10,000-item ring that freezes when
// paused) and the loop that feeds it the way the live channel would.

import { useState } from 'react'
import { FeedList } from '@/components/console/feed-list'
import { LogLine, type LogLineLevel } from '@/components/console/log-line'
import { createFeedStore } from '@/lib/live/feed-store'
import type { FeedRun } from './runs'

interface Line {
  cursor: string
  time: string
  level: LogLineLevel
  source: string
  message: string
}

const store = createFeedStore<Line>({
  max: 10_000,
  key: (line) => line.cursor,
  pausedMode: 'freeze',
})

const LEVELS: readonly LogLineLevel[] = [
  'info',
  'info',
  'debug',
  'info',
  'info',
  'warn',
  'info',
  'info',
  'info',
  'error',
]
const SOURCES = ['greet', 'onUserCreated', 'processOrder', 'auth', 'pubsub', 'tasks', 'storage']
const MESSAGES = [
  'greet: hello ada',
  'Function execution started',
  'Function execution took 12 ms, finished with status code: 200',
  'processOrder: charged order ord_19 for 3,097 EUR',
  'sign-in u_k65eq with password',
  'publish to orders-created: 1 message',
  'retry 2 of 5 for task send-receipt/ord_19',
  'TypeError: Cannot read properties of undefined (reading "uid")\n    at greet (functions/index.js:12:5)\n    at invoke (worker.js:88:20)',
  'object users/u_k65eq/avatar.png finalized (48.2 KB)',
  'slow query on orders: 1,204 documents read for 20 results',
]
/** Each message as JSON once: the engine sends entries already serialized. */
const MESSAGE_JSON = MESSAGES.map((message) => JSON.stringify(message))

/**
 * One window as the engine sends it: entries serialized once and joined
 * under `items` (foundation §6.5), here with fresh cursors.
 */
function windowText(from: number, count: number): string {
  const time = new Date().toISOString()
  const parts: string[] = []
  for (let offset = 0; offset < count; offset += 1) {
    const n = from + offset
    parts.push(
      `{"cursor":"${n}","time":"${time}","level":"${LEVELS[n % LEVELS.length]}","source":"${SOURCES[n % SOURCES.length]}","message":${MESSAGE_JSON[n % MESSAGE_JSON.length]}}`,
    )
  }
  return `{"items":[${parts.join(',')}]}`
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

export async function feed(perSecond: number, seconds: number): Promise<FeedRun> {
  const perWindow = Math.round(perSecond / 10)
  const windows = Math.round(seconds * 10)
  const started = performance.now()
  let next = 0
  let late = 0
  for (let window = 0; window < windows; window += 1) {
    const due = started + window * 100
    const wait = due - performance.now()
    if (wait > 0) await sleep(wait)
    else if (wait < -100) late += 1
    // What a page's topic handler does with an event: one parse, one push.
    const { items } = JSON.parse(windowText(next, perWindow)) as { items: Line[] }
    store.push(items)
    next += perWindow
  }
  await frame()
  await frame()
  return {
    pushed: next,
    size: store.size(),
    dropped: store.dropped(),
    drawn: document.querySelectorAll('[data-testid="feed-row"]').length,
    newestShown: document.querySelector(`[data-key="${next - 1}"]`) !== null,
    late,
  }
}

function renderLine(line: Line) {
  return (
    <LogLine
      className="w-full"
      time={line.time}
      level={line.level}
      source={line.source}
      message={line.message}
    />
  )
}

const lineKey = (line: Line) => line.cursor

const HEADER = (
  <div className="grid h-7 grid-cols-[104px_44px_120px_minmax(0,1fr)] items-center gap-x-2 px-3 font-mono text-[11px] text-kumo-subtle">
    <span>time</span>
    <span className="pl-2">level</span>
    <span>source</span>
    <span>message</span>
  </div>
)

export function FeedHarness() {
  const [follow, setFollow] = useState(true)
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-kumo-base text-kumo-default">
      <FeedList<Line>
        ariaLabel="Log lines"
        store={store}
        order="newest-last"
        rowHeight={24}
        rowKey={lineKey}
        renderRow={renderLine}
        follow={follow}
        onFollowChange={setFollow}
        header={HEADER}
        empty={<p className="p-6 text-[13px] text-kumo-subtle">No lines yet.</p>}
        testId="kit-feed"
      />
    </div>
  )
}
