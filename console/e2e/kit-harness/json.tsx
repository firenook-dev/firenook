// The JSON half of the kit harness: a JsonView in an inspector-wide column
// (the way an inspector shows an event, a message or a log payload), handed
// a value parsed from a text of a few megabytes, and the time from that
// value to the first frame painted with the tree in it.

import { useEffect, useState } from 'react'
import { JsonView } from '@/components/console/json-view'
import type { JsonRun } from './runs'

let hand: ((value: { value: unknown }) => void) | undefined

/** Values in one record of `record(n)`: 9 containers and 25 leaves. */
const NODES_PER_RECORD = 34

/** One order of an export: nested objects and arrays, the shapes a payload has. */
function record(n: number): string {
  const id = String(n).padStart(6, '0')
  const minute = String(n % 60).padStart(2, '0')
  return `{"id":"ord_${id}","createdAt":"2026-10-12T09:${minute}:02.118Z","status":"${n % 7 === 0 ? 'refunded' : 'paid'}","customer":{"uid":"u_${id}","email":"buyer${n}@example.test","name":"Buyer ${n}","tier":"${n % 3 === 0 ? 'gold' : 'standard'}"},"items":[{"sku":"sku_${n % 97}","qty":${(n % 4) + 1},"price":1299},{"sku":"sku_${n % 89}","qty":1,"price":499}],"total":${3097 + (n % 500)},"currency":"EUR","shipping":{"method":"express","address":{"line1":"${n} Analytical Row","city":"London","postcode":"N1 9GU","country":"GB"}},"notes":null,"tags":["priority","gift"],"flags":{"fraudCheck":${n % 2 === 0},"giftWrap":false}}`
}

/** An array of records, about `megabytes` long. */
function payload(megabytes: number): { text: string; nodes: number } {
  const target = megabytes * 1024 * 1024
  const parts: string[] = []
  let length = 2
  while (length < target) {
    const next = record(parts.length)
    parts.push(next)
    length += next.length + 1
  }
  return { text: `[${parts.join(',')}]`, nodes: 1 + parts.length * NODES_PER_RECORD }
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

/**
 * Resolves once a frame holding tree rows has been painted: checked in a
 * frame callback (after React's commit, before the paint), and a message
 * posted from there arrives after that frame is on screen.
 */
function paintedWithRows(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!document.querySelector('[data-testid="kit-json-tree"] [role="treeitem"]')) {
        requestAnimationFrame(check)
        return
      }
      const channel = new MessageChannel()
      channel.port1.addEventListener('message', () => resolve(), { once: true })
      channel.port1.start()
      channel.port2.postMessage(null)
    }
    requestAnimationFrame(check)
  })
}

export async function showJson(megabytes: number): Promise<JsonRun> {
  const { text, nodes } = payload(megabytes)
  await frame()
  await frame()
  const started = performance.now()
  const value = JSON.parse(text) as unknown
  const parsed = performance.now()
  if (!hand) throw new Error('The JSON view is not mounted')
  hand({ value })
  await paintedWithRows()
  const painted = performance.now()
  return {
    bytes: text.length,
    nodes,
    parseMs: parsed - started,
    paintMs: painted - parsed,
    drawn: document.querySelectorAll('[data-testid="kit-json-tree"] [role="treeitem"]').length,
  }
}

export function JsonHarness() {
  const [data, setData] = useState<{ value: unknown } | null>(null)
  useEffect(() => {
    hand = setData
    return () => {
      hand = undefined
    }
  }, [])
  return (
    <div className="flex h-dvh min-h-0 bg-kumo-canvas text-kumo-default">
      <div className="min-w-0 flex-1" />
      <aside className="flex w-[560px] min-w-0 flex-col border-l border-kumo-line bg-kumo-base">
        {data === null ? (
          <p className="p-6 text-[13px] text-kumo-subtle">No payload yet.</p>
        ) : (
          <JsonView value={data.value} testId="kit-json" />
        )}
      </aside>
    </div>
  )
}
