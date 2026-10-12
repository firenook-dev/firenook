// The facts of an inspector: label on the left, value on the right, one
// alignment for every inspector in the console.
//
// It is the field editor's layout stood still. One grid of two tracks —
// the labels' column sized to the widest label (`max-content`), the values
// taking the rest — and each row a `subgrid` of it, so every value starts
// at the same offset with no measuring, and each row can still paint its
// own hover ground and carry its own copy control. A label is English, so
// it is the interface face at 13 px, quiet; a value is data, so it is the
// data face at 12 px unless it says otherwise, and it wraps rather than
// being cut short — a URL truncated at the panel's edge loses its path,
// which is the half that says anything.
//
// The copy control floats over the end of the row on hover, with its own
// ground and hairline, the way the field rows' strip does: reserving its
// place cost a quarter of every row for a button nobody sees at rest.

import { Tooltip } from '@cloudflare/kumo'
import type { ReactNode } from 'react'
import { MaskedValue } from './masked-value'
import { CopyStripButton } from './strip-button'

export interface KeyValueItem {
  /** English, sentence case — or the data's own name where the row is data (`uid`). */
  label: string
  value: ReactNode
  /** What the row's copy button copies; no button without it. */
  copy?: string | undefined
  /** The data face (the default); `false` for a value that is English ("3 d ago"). */
  mono?: boolean | undefined
  /** A tooltip on the value: the exact instant behind "3 d ago". */
  hint?: string | undefined
  /** Hidden until asked for: `value` (a string) or `reveal`'s answer, as `MaskedValue`. */
  masked?: boolean | undefined
  /** For a masked row whose value only the engine holds. */
  reveal?: ((signal: AbortSignal) => Promise<string>) | undefined
  /** For a masked row with `reveal`: how long the hidden value is. */
  length?: number | undefined
  testId?: string | undefined
}

/**
 * The rows' floating copy control: hidden and unclickable until its row is
 * pointed at, shown on its own focus so a Tab still reaches it.
 */
const STRIP =
  'pointer-events-none absolute top-0.5 right-1 flex items-center rounded-md bg-kumo-base px-0.5 opacity-0 shadow-sm ring ring-kumo-line group-hover/kv:pointer-events-auto group-hover/kv:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100'

export function KeyValueList({
  items,
  testId,
}: {
  items: readonly KeyValueItem[]
  testId?: string | undefined
}) {
  return (
    <dl
      className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-0.5"
      data-testid={testId}
    >
      {items.map((item) => (
        <div
          key={item.testId ?? item.label}
          className="group/kv relative col-span-2 -mx-2 grid grid-cols-subgrid items-start rounded-md px-2 py-1 hover:ink"
          data-testid={item.testId}
        >
          <dt className="max-w-40 text-[13px] leading-5 break-words text-kumo-subtle">
            {item.label}
          </dt>
          <dd
            className={`m-0 min-w-0 leading-5 [overflow-wrap:anywhere] text-kumo-default ${
              item.mono === false ? 'text-[13px]' : 'font-mono text-[12px]'
            }`}
          >
            <Value item={item} />
          </dd>
          {item.copy !== undefined && item.masked !== true && (
            <span className={STRIP}>
              <CopyStripButton
                value={item.copy}
                label={`Copy ${item.label}`}
                testId={item.testId && `${item.testId}-copy`}
              />
            </span>
          )}
        </div>
      ))}
    </dl>
  )
}

function Value({ item }: { item: KeyValueItem }) {
  if (item.masked === true) {
    const text = typeof item.value === 'string' ? item.value : undefined
    return (
      <MaskedValue
        value={text}
        reveal={item.reveal}
        length={item.length}
        label={`Show ${item.label}`}
        copyable={item.copy !== undefined || text !== undefined}
        testId={item.testId && `${item.testId}-masked`}
      />
    )
  }
  if (item.hint === undefined) return <>{item.value}</>
  return (
    <Tooltip content={item.hint} render={<span className="cursor-default">{item.value}</span>} />
  )
}
