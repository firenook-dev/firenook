// The pieces a decision's detail is made of on every rules page: a titled
// band, a term and its value, and the lines of the rules that ran — each a
// way into the editor while the editor holds the rules that decided it.

import { Text } from '@cloudflare/kumo'
import type { ReactNode } from 'react'
import { ruleLine } from './text'

/** One band of a decision's detail: a 12 px heading, an optional note, the content. */
export function DetailSection({
  title,
  note,
  children,
  testId,
}: {
  title: string
  note?: string | undefined
  children: ReactNode
  testId?: string | undefined
}) {
  return (
    <section
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-b border-kumo-line px-3 py-3"
      data-testid={testId}
    >
      <Text as="h3" size="xs" bold>
        {title}
      </Text>
      {note && (
        <Text size="xs" variant="secondary">
          {note}
        </Text>
      )}
      {children}
    </section>
  )
}

/** A term in a detail's facts. */
export function Term({ children }: { children: ReactNode }) {
  return <dt className="text-kumo-subtle">{children}</dt>
}

/** A value in a detail's facts: data, in the data face. */
export function Mono({ children }: { children: ReactNode }) {
  return <dd className="min-w-0 truncate font-mono text-kumo-default">{children}</dd>
}

/** A line of the rules that ran, how often, and whether it allowed. */
export interface RanLine {
  line: number
  allowed: boolean
  times: number
}

/**
 * The lines that ran, each once, in the order they first ran, with how many
 * times: a query proof can run the same allow once per branch.
 */
export function countLines(entries: ReadonlyArray<{ line: number; allowed: boolean }>): RanLine[] {
  const out: RanLine[] = []
  for (const entry of entries) {
    const known = out.find((item) => item.line === entry.line && item.allowed === entry.allowed)
    if (known) known.times += 1
    else out.push({ line: entry.line, allowed: entry.allowed, times: 1 })
  }
  return out
}

/** The lines that ran, the deciding ones in the default ink; each reveals its line. */
export function RuleLines({
  lines,
  deciding,
  rules,
  sameRules,
  onReveal,
}: {
  lines: readonly RanLine[]
  deciding: ReadonlySet<number>
  /** The rules that decided it; the lines are read from this text. */
  rules: string
  /** The editor holds `rules`, so a line can be revealed there. */
  sameRules: boolean
  onReveal: (line: number) => void
}) {
  return (
    <ul className="grid min-w-0 gap-0.5" data-testid="decision-lines">
      {lines.map((line) => (
        <li key={`${line.line}-${line.allowed}`} className="min-w-0">
          <button
            type="button"
            disabled={!sameRules}
            onClick={() => onReveal(line.line)}
            className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left enabled:hover:ink disabled:cursor-default"
          >
            <span className="w-14 shrink-0 font-mono text-[11px] whitespace-nowrap text-kumo-subtle tabular-nums">
              line {line.line}
            </span>
            <span
              className={`w-12 shrink-0 text-[11px] ${
                line.allowed ? 'text-kumo-success' : 'text-kumo-danger'
              }`}
            >
              {line.allowed ? 'allowed' : 'refused'}
            </span>
            <span
              className={`min-w-0 truncate font-mono text-[12px] ${
                deciding.has(line.line) ? 'text-kumo-default' : 'text-kumo-subtle'
              }`}
            >
              {ruleLine(rules, line.line)}
            </span>
            {line.times > 1 && (
              <span className="ml-auto shrink-0 text-[11px] text-kumo-subtle tabular-nums">
                ×{line.times}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}
